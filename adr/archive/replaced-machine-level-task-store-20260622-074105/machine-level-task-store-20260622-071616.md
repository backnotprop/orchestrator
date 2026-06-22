# Spec: Machine-Level Task Store

## Intent

Support one Orchestrator installation managing agents across many repos,
subdirectories, and eventually remote locations.

This does not replace repo-local operation. It adds a global management mode for
large multi-agent use.

## Definitions

- `store`: where Orchestrator task records live.
- `workspace`: the project or repo context for config, labels, and grouping.
- `cwd`: the exact directory where the agent process runs.

Current code treats `workspace` as the default store boundary. Global mode must
separate these concepts.

## CLI Modes

Repo-local mode remains the default:

```sh
orchestrator ps
orchestrator launch codex "Review this repo."
```

Global mode is explicit:

```sh
orchestrator ps --global
orchestrator ps --global --watch
orchestrator ps --global --active --json --compact --brief
```

Task commands also accept `--global`:

```sh
orchestrator read --global <task-id>
orchestrator logs --global <task-id>
orchestrator events --global <task-id>
orchestrator watch --global <task-id>
orchestrator interrupt --global <task-id>
orchestrator interrupt --global --group <group-id>
```

Launch can write into the global store:

```sh
orchestrator launch codex \
  --global \
  --workspace /Users/me/oss/api \
  --cwd /Users/me/oss/api/packages/server \
  --name "server review" \
  --model gpt-5.4-mini \
  "Review the server package."
```

`run --background` should support the same model later:

```sh
orchestrator run --global --background --workspace /Users/me/oss/api \
  "Launch a Claude Code agent to review migrations and a Codex agent to inspect tests."
```

## Store Resolution

Add an internal store scope:

```ts
type TaskStoreScope = "workspace" | "global";
```

Resolve task roots as:

```ts
type ResolvedTaskStore = {
  scope: TaskStoreScope;
  root: string;
};
```

Rules:

- workspace scope defaults to `<workspace>/.orchestrator/tasks`;
- global scope defaults to `~/.orchestrator/tasks`;
- the visible default should stay the home dot path, matching the current global
  config docs;
- the resolver can also support XDG state locations later, but callers should
  not need to know that for normal use;
- `--orchestrator-dir <path>` overrides the store root in either mode;
- `--global` maps to `scope: "global"`;
- no `--global` maps to `scope: "workspace"`.

Keep `--orchestrator-dir` as an advanced override. Do not make users pass it for
normal global mode.

## Task Record Changes

Extend `AgentTaskRecord`:

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
      host?: string;
    };

type AgentTaskRecord = ExistingAgentTaskRecord & {
  storeScope?: TaskStoreScope;
  location?: TaskLocation;
  labels?: Record<string, string>;
};
```

Compatibility:

- keep existing top-level `cwd`;
- old tasks without `location` infer `kind: "local"` and `cwd` from the existing
  task record;
- old workspace-store tasks infer `workspaceRoot` from the current store options;
- global-store tasks should always write `location`.

## Launch Input Changes

Extend `LaunchTaskInput`:

```ts
type LaunchTaskInput = ExistingLaunchTaskInput & {
  storeScope?: TaskStoreScope;
  location?: TaskLocation;
  labels?: Record<string, string>;
};
```

For local launches:

- `location.kind = "local"`;
- `location.workspaceRoot = resolved workspace`;
- `location.cwd = launch plan cwd`;
- top-level `cwd` remains `launchPlan.cwd`.

For global launch, `--workspace` should be required or default to `process.cwd()`.
Use absolute paths in examples and machine-generated command args.

## Batch Launch Changes

Extend launch manifests with optional per-task `workspace`, `cwd`, and `labels`:

```json
{
  "schemaVersion": 1,
  "defaults": {
    "runtime": "codex",
    "workspace": "/Users/me/oss/api",
    "model": "gpt-5.4-mini"
  },
  "tasks": [
    {
      "cwd": "/Users/me/oss/api/packages/server",
      "name": "server review",
      "task": "Review the server package."
    },
    {
      "workspace": "/Users/me/oss/web",
      "cwd": "/Users/me/oss/web/apps/site",
      "name": "site review",
      "task": "Review the site app."
    }
  ]
}
```

Relative `cwd` in a manifest should resolve against that task's workspace, not
the shell's current directory.

## Global View

Human `ps --global` should make location visible.

Example:

```text
updated 22:11:04  18 running  93 done  4 failed  221k tok

agent        work             status   repo      cwd              dur   tok   last          id
codex        server review    running  api       packages/server  2m    18k   reading       a6d00f1d
claude-code  site review      done     web       apps/site        47s   31k   completed     b7e14a2c
custom       inbox cleanup    running  personal  remote:mailbox   6m    -     running       c93ab8e1
```

For compact JSON, add location to each task:

```json
{
  "id": "a6d00f1d",
  "taskId": "a6d00f1d-...",
  "runtime": "codex",
  "name": "server review",
  "status": "running",
  "location": {
    "kind": "local",
    "workspaceRoot": "/Users/me/oss/api",
    "cwd": "/Users/me/oss/api/packages/server"
  }
}
```

## Filters

Global `ps` should support filters before rendering:

```sh
orchestrator ps --global --active
orchestrator ps --global --runtime codex
orchestrator ps --global --status running
orchestrator ps --global --workspace /Users/me/oss/api
orchestrator ps --global --cwd /Users/me/oss/api/packages/server
orchestrator ps --global --parent <run-id>
```

Later filters:

```sh
orchestrator ps --global --label repo=api
orchestrator ps --global --remote
```

## Interrupt Scope

Global interrupt should require explicit scope for broad operations:

```sh
orchestrator interrupt --global <task-id>
orchestrator interrupt --global --group <group-id>
orchestrator interrupt --global --parent <parent-id> --children
orchestrator interrupt --global --active --workspace /Users/me/oss/api
```

Do not allow `orchestrator interrupt --global --active` without either:

- confirmation in a human flow, or
- `--yes` for non-interactive callers.

That avoids accidental machine-wide budget damage.

## Returned Commands

Compact JSON returned commands should carry store scope:

```json
{
  "commands": {
    "active": {
      "args": ["ps", "--global", "--active", "--json", "--compact", "--brief"]
    }
  }
}
```

For global mode, do not use local returned commands that depend on the caller's
cwd. Global views can span many workspaces, so command args must stay portable.

If `--orchestrator-dir` is used with global mode, returned args must include it.

## Parent Agent Tools

Parent tools should continue to expose simple operations:

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

When the parent session is running in global mode, child launches should write to
the global store and persist each child's location.

## Remote Path

Remote agents should be represented as local task records with remote location
metadata.

First slice only prepares the task model:

```ts
{
  kind: "remote",
  remote: "agents.example.com",
  workspace: "mail",
  remoteTaskId: "remote-123"
}
```

Do not implement remote transport in the machine-store slice.

## Implementation Order

1. Add store-scope resolution helpers.
2. Persist `location` and `storeScope` on newly launched tasks.
3. Add `--global` parsing to task commands.
4. Make `ps --global` read the global store and show location.
5. Extend compact JSON rows with `location`.
6. Update returned command args for global mode.
7. Extend batch launch manifests with per-task `workspace`, `cwd`, and labels.
8. Extend parent tools with optional per-child `workspace` and `labels`.
9. Add scoped global interrupt safeguards.

## Tests

Add tests for:

- repo-local defaults remain unchanged;
- `launch --global` writes under the global store;
- task records include `location`;
- `ps --global` shows tasks from multiple workspaces;
- `ps --global --workspace <path>` filters correctly;
- short IDs resolve inside the selected global store;
- compact JSON includes location;
- returned global commands include `--global`;
- global returned commands keep `--orchestrator-dir` when provided;
- batch launch can target multiple workspaces;
- old task records without `location` remain readable.

## Non-Goals

- Do not replace repo-local task stores.
- Do not implement remote HTTP agents in this slice.
- Do not add a database until the filesystem store proves insufficient.
- Do not make `--workspace` ambiguous: without `--global` it selects the
  workspace store; with `--global` it describes or filters task location.

## Related Records

- [ADR 6: Treat subagents as durable asynchronous task sessions](../decisions/0006-treat-subagents-as-durable-asynchronous-task-sessions.md)
- [ADR 23: Build multi-agent operations view from task state](../decisions/0023-build-multi-agent-operations-view-from-task-state-20260618-145801.md)
- [ADR 24: Run parent agent as managed background task](../decisions/0024-run-parent-agent-as-managed-background-task-20260618-193203.md)
- [ADR 28: Add compact machine control view](../decisions/0028-add-compact-machine-control-view-20260620-082105.md)
- [Spec: Batch launch CLI](batch-launch-cli-20260622-050535.md)
- [Spec: Local returned command args](local-returned-command-args-20260622-063117.md)
