# Spec: Extract `ps`

Date: 2026-06-22

## Intent

Continue reducing `packages/cli/src/cli.ts` without changing CLI behavior. Extract `orchestrator ps` execution into its own command module.

## Scope

Create:

```text
packages/cli/src/commands/ps.ts
```

Update:

```text
packages/cli/src/cli.ts
```

No changes are expected in core task storage, runtime registry, ps view construction, compact ps view construction, human ps rendering, terminal frame rendering, or command contracts.

## New Command Module

`packages/cli/src/commands/ps.ts` should export:

```ts
export type PsOptions = {
  workspaceRoot: string;
  orchestratorDir?: string;
  configPath?: string;
  json: boolean;
  status?: TaskStatus;
  runtime?: string;
  parentRunId?: string;
  all: boolean;
  allWorkspaces: boolean;
  cwd?: string;
  watch: boolean;
  compact: boolean;
  brief: boolean;
  active: boolean;
  intervalMs: number;
};

export async function commandPs(options: PsOptions): Promise<void>;
```

Move these helpers into the same file as private functions:

- `loadPsView`
- `validatePsRuntimeFilter`
- `formatPsJsonView`
- `withPortableStopArgs`
- `appendGroupControlCommandArgs`
- `appendControlCommandArgs`
- `appendStopArgs`
- `viewArgsSuffix`
- `filterPsViewByParent`
- `resolvePsGroupId`
- `psRowGroupId`
- ps-local `delay`

## `cli.ts` Changes

Import:

```ts
import { commandPs, type PsOptions } from "./commands/ps.ts";
```

Remove from `cli.ts`:

- local `PsOptions`
- local `commandPs`
- local `loadPsView`
- local `validatePsRuntimeFilter`
- local `formatPsJsonView`
- local ps portable command helpers
- local parent/group filtering helpers
- local `delay`, if no remaining code needs it

Keep in `cli.ts`:

- `parsePsOptions`
- command dispatch
- help text
- JSON help contract
- parser error behavior
- `parseTaskStatus`
- common option parsing helpers

## Dependencies In `ps.ts`

Import from `@backnotprop/orchestrator-core`:

```ts
import {
  buildAgentTaskPsView,
  compactAgentTaskPsView,
  listTaskIds,
  listTasks,
  loadConfiguredRuntimeRegistry,
  taskGroupId,
  UNGROUPED_GROUP_ID,
  type AgentTaskControlView,
  type AgentTaskPsView,
  type TaskStatus,
} from "@backnotprop/orchestrator-core";
```

Import from CLI modules:

```ts
import { CliError } from "../cli-errors.ts";
import { jsonLine } from "../json-output.ts";
import { compactPsViewCommands } from "../ps-view-commands.ts";
import { renderPsView } from "../render-ps.ts";
import { stopArgsSuffix } from "../task-output.ts";
import { countRenderedLines, renderWatchFrame, terminalColumns } from "../terminal-frame.ts";
```

## Behavior Requirements

Preserve:

- `ps` human grouped operations view
- `ps --json` full view output
- `ps --json --compact` compact machine-control output
- `ps --json --compact --brief`
- `ps --json --compact --active`
- `ps --all`
- `ps -A` / `ps --all-workspaces`
- `ps --cwd`
- `ps --runtime`
- unknown runtime validation behavior and error shape
- `ps --status`
- `ps --parent`
- parent/group prefix resolution
- ambiguous parent/group error metadata and hints
- compact view `views.active`, `views.recent`, and `views.all`
- portable args for compact view commands
- portable args for group commands
- portable args for task commands
- stop args for selected tasks/groups
- `ps --watch` human TTY redraw behavior
- `ps --watch` non-TTY `---` frame behavior
- `ps --watch --json` one-line JSON frame behavior
- `ps --watch --json --compact --active`
- current parser errors for invalid option combinations

## Verification

Run:

```bash
pnpm run typecheck
node --experimental-strip-types --test test/cli-ps.test.ts test/cli-launch.test.ts test/cli-errors.test.ts test/cli-contract.test.ts
pnpm run check
```

`test/cli-ps.test.ts` is the main guard. `test/cli-launch.test.ts` covers workspace filtering and portable compact ps commands. `test/cli-errors.test.ts` covers machine-readable error/recovery behavior. `test/cli-contract.test.ts` protects help and command-contract references.

## Acceptance Criteria

- `cli.ts` no longer owns `ps` execution or ps-specific helpers.
- `cli.ts` still owns `parsePsOptions`.
- `commands/ps.ts` owns ps snapshot and watch behavior.
- Existing ps text output remains unchanged.
- Existing ps JSON and compact JSON output remain unchanged.
- Full check passes.
