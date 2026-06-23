# Spec: Extract `list`

Date: 2026-06-22

## Intent

Finish the command-execution extraction pass before parser cleanup. Extract `orchestrator list` into its own command module without changing CLI behavior.

## Scope

Create:

```text
packages/cli/src/commands/list.ts
```

Update:

```text
packages/cli/src/cli.ts
```

No parser cleanup, output redesign, help contract changes, or core task-store changes should be included in this slice.

## New Command Module

`packages/cli/src/commands/list.ts` should export:

```ts
export type ListOptions = {
  workspaceRoot: string;
  orchestratorDir?: string;
  configPath?: string;
  json: boolean;
  status?: TaskStatus;
  allWorkspaces: boolean;
};

export async function commandList(options: ListOptions): Promise<void>;
```

The module should own these private helpers:

- `formatTaskListLine`
- `displayTaskName`
- `taskModel`
- `formatTaskAge`
- `summarizeTask`

## `cli.ts` Changes

Import:

```ts
import { commandList, type ListOptions } from "./commands/list.ts";
```

Remove from `cli.ts`:

- local `ListOptions`
- local `commandList`
- local `formatTaskListLine`
- local `displayTaskName`
- local `taskModel`
- local `formatTaskAge`
- local `summarizeTask`
- list-only imports from `@backnotprop/orchestrator-core`
- list-only import of `summarizeTaskPrompt`
- list-only import of `formatInline`

Keep in `cli.ts`:

- `parseListOptions`
- command dispatch
- `parseTaskStatus`
- `TASK_STATUSES`
- common parser helpers
- help text and JSON help contract

## Behavior Requirements

Preserve:

- `orchestrator list`
- `orchestrator list --json`
- `orchestrator list --status <status>`
- `orchestrator list -A`
- `orchestrator list --all-workspaces`
- `orchestrator list --workspace <path>`
- `orchestrator list --orchestrator-dir <path>`
- `orchestrator list --config <path>`
- accepted common options before the command
- JSON output as pretty-printed full task records
- human empty output as `No tasks.\n`
- tab-separated human rows
- row columns: name, status, runtime, model, age, task id
- task name fallback to prompt summary
- unnamed fallback to `(unnamed)`
- model fallback from runtime `modelFlag`
- age formatting
- workspace filtering through `matchesTaskWorkspace`
- config loading before output, including for `--json`

## Dependencies In `list.ts`

Expected core imports:

```ts
import {
  getRuntimeConfig,
  listTasks,
  loadConfiguredRuntimeRegistry,
  matchesTaskWorkspace,
  type AgentTaskRecord,
  type RuntimeRegistry,
  type TaskStatus,
} from "@backnotprop/orchestrator-core";
```

Expected CLI imports:

```ts
import { summarizeTaskPrompt } from "../task-labels.ts";
import { formatInline } from "../terminal-format.ts";
```

`cli.ts` should keep `TaskStatus` only if it is still needed by parser types, and should keep `TASK_STATUSES` for `parseTaskStatus`.

## Verification

Run:

```bash
pnpm run typecheck
node --experimental-strip-types --test test/cli-read.test.ts test/cli-launch.test.ts test/cli-contract.test.ts
pnpm run check
```

`test/cli-read.test.ts` protects list fallback output and basic JSON listing. `test/cli-launch.test.ts` protects task names and normalized workspace filtering. `test/cli-contract.test.ts` protects the help contract references to `list`.

## Acceptance Criteria

- `cli.ts` no longer owns `list` command execution.
- `cli.ts` no longer owns list human row formatting helpers.
- `cli.ts` still owns `parseListOptions`.
- `commands/list.ts` owns list output behavior.
- Existing list text, JSON, filtering, and config behavior are unchanged.
- Full check passes.
