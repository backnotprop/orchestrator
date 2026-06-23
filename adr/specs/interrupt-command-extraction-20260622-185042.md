# Spec: Extract `interrupt`

Date: 2026-06-22

## Intent

Continue shrinking `packages/cli/src/cli.ts` without changing CLI behavior. Extract `orchestrator interrupt` into its own command module.

## Scope

Create:

```text
packages/cli/src/commands/interrupt.ts
```

Update:

```text
packages/cli/src/cli.ts
```

No core task-store or supervisor behavior should change.

## New Command Module

`packages/cli/src/commands/interrupt.ts` should export:

```ts
export type InterruptOptions = {
  workspaceRoot: string;
  orchestratorDir?: string;
  configPath?: string;
  json: boolean;
  taskIds: readonly string[];
  parentId?: string;
  groupId?: string;
  active: boolean;
  allWorkspaces: boolean;
  children: boolean;
  taskOnly: boolean;
  yes: boolean;
  reason?: string;
  signal?: NodeJS.Signals;
  compact: boolean;
};

export function validateInterruptOptions(options: InterruptOptions): InterruptOptions;

export async function commandInterrupt(options: InterruptOptions): Promise<number>;
```

Private helpers in the new module:

- `interruptSelectors`
- `interruptSelectorError`
- `incompatibleInterruptOptionsError`
- `interruptTargetFromOptions`
- `isSingleTaskInterrupt`
- `printInterruptTasksResult`

## `cli.ts` Changes

Import:

```ts
import {
  commandInterrupt,
  validateInterruptOptions,
  type InterruptOptions,
} from "./commands/interrupt.ts";
```

Remove from `cli.ts`:

- local `InterruptOptions`
- local `commandInterrupt`
- local interrupt selector validation helpers
- local `interruptTargetFromOptions`
- local `isSingleTaskInterrupt`
- local `printInterruptTasksResult`
- interrupt-only imports from core and CLI helper modules

Keep in `cli.ts`:

- `parseInterruptOptions`
- command dispatch
- help text
- JSON help contract
- generic option parsing helpers
- `missingTaskIdError`
- `duplicateTaskIdError`

At the end of `parseInterruptOptions`, construct the same options object and return:

```ts
return validateInterruptOptions(options);
```

## Behavior Requirements

Preserve:

- `interrupt <task-id|prefix>`
- multiple task id interruption
- `interrupt <task-id|prefix> --children`
- `interrupt <task-id|prefix> --task-only`
- `interrupt --parent <task-id|prefix> --children`
- `interrupt --group <group-id|prefix>`
- broad `ungrouped` group rejection
- `interrupt --active`
- `interrupt -A --active --yes`
- `--reason`
- `--signal`
- `--json`
- `--json --compact`
- compact requiring JSON
- one selector only: task id, `--parent`, `--group`, or `--active`
- `--parent` requiring `--children`
- `--children` and `--task-only` incompatibility
- `--active` incompatibility with `--children` and `--task-only`
- multiple task ids incompatibility with `--children` and `--task-only`
- `-A --active` requiring `--yes`
- single-task non-JSON output through `printTask`
- human multi-task summary output
- full JSON interrupt summary
- compact JSON interrupt summary
- existing exit code behavior

## Dependencies In `interrupt.ts`

Expected core imports:

```ts
import {
  interruptTasks,
  listTaskIds,
  type InterruptTasksResult,
  type InterruptTasksTarget,
} from "@backnotprop/orchestrator-core";
```

Expected CLI helper imports:

```ts
import { CliError } from "../cli-errors.ts";
import { jsonLine } from "../json-output.ts";
import { compactInterruptTasksResult, summarizeInterruptTasksResult } from "../task-json.ts";
import { printTask } from "../task-output.ts";
```

## Verification

Run:

```bash
pnpm run typecheck
node --experimental-strip-types --test test/cli-interrupt.test.ts test/cli-errors.test.ts test/cli-contract.test.ts test/cli-ps.test.ts test/cli-run.test.ts test/cli-read.test.ts
pnpm run check
```

`test/cli-interrupt.test.ts` is the primary guard. The other files protect error shape, help text, returned stop args, and parent/child cleanup flows.

## Acceptance Criteria

- `cli.ts` no longer owns interrupt command execution.
- `cli.ts` still owns argv parsing for interrupt.
- `commands/interrupt.ts` owns interrupt-specific validation and rendering.
- Core interruption behavior is untouched.
- Existing interrupt text, JSON, compact JSON, and exit behavior are unchanged.
- Full check passes.
