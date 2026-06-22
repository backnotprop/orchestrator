# Research Spike: Single Control-Plane Task Store

## Question

Should Orchestrator use one machine-level task store by default, closer to the
Kubernetes model, instead of having separate repo-local and global modes?

## Current Code Shape

The current task root is derived from `workspaceRoot`:

```ts
join(options.orchestratorDir ?? join(options.workspaceRoot, ".orchestrator"), "tasks");
```

That makes `workspaceRoot` do too much:

- it picks the task store;
- it acts as the default process `cwd`;
- it scopes `ps`, `read`, `logs`, `events`, and `interrupt`;
- it appears in returned command args so follow-up commands can find the same
  store.

That worked while Orchestrator was repo-local. It becomes awkward for one
Orchestrator installation managing many repos.

## Existing Command Semantics

`orchestrator ps --all` already means "show all task history in the selected
store" rather than "show all workspaces."

That matters because the Kubernetes-style flag should not reuse `--all`.

Use:

```sh
orchestrator ps -A
orchestrator ps --all-workspaces
```

for all workspaces.

Keep:

```sh
orchestrator ps --all
```

for all history.

Then this is valid and clear:

```sh
orchestrator ps -A --all
```

Meaning: all workspaces, all history.

## Kubernetes Model

The useful Kubernetes shape is:

- one control plane;
- current context selects the default view;
- namespace narrows the view;
- `-A` / `--all-namespaces` shows everything;
- labels filter resources;
- owner relationships group resources;
- logs and delete operate against resources in the same control plane.

Mapped to Orchestrator:

- machine task store: control plane;
- workspace: namespace-like project scope;
- `cwd`: where the process runs;
- task: pod/job-like resource;
- parent run: owner/group;
- labels: labels;
- `ps`: get/watch resources;
- `logs`: logs;
- `interrupt`: stop the resource.

This is a better mental model than repo-local vs global stores.

## Revised Direction

The default task store should be machine-level:

```text
~/.orchestrator/tasks
```

Task commands should query that store by default.

The default view should still be narrow:

```sh
orchestrator ps
```

shows the current workspace.

To see everything:

```sh
orchestrator ps -A
```

That gives one model with scoped views, instead of two separate stores.

## Workspace and Cwd

`workspace` and `cwd` remain important, but neither should choose the default
store.

Recommended meaning:

- `workspace`: project/repo grouping and default view filter;
- `cwd`: exact execution directory for the agent process.

For a monorepo:

```sh
orchestrator launch codex \
  --workspace /repo \
  --cwd /repo/packages/api \
  --name "api review" \
  "Review the API package."
```

For a nested repo or subproject:

```sh
orchestrator launch codex \
  --workspace /repo/packages/api \
  --cwd /repo/packages/api \
  --name "api review" \
  "Review the API package."
```

Both write to the same machine store.

## Store Override

Repo-local storage can still exist as an advanced override:

```sh
orchestrator ps --orchestrator-dir /repo/.orchestrator
```

But it should not be the main product model.

Use that for tests, isolated experiments, or users who explicitly want a custom
store.

## Current Gaps

To support this model cleanly, current code needs:

- a default machine-store resolver;
- first-class task location metadata;
- `ps -A` / `--all-workspaces`;
- workspace filtering from task metadata instead of store path;
- compact JSON commands that do not repeat `--workspace` for every task command;
- returned commands that include custom store context only when needed;
- parent-agent tools that can launch children into different workspaces while
  sharing one task store.

## Finding

The previous two-mode spec was too cautious. The product should feel like one
control plane. Workspace is a view/filter, not the storage boundary.
