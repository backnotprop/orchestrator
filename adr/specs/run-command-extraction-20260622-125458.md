# Spec: Extract `orchestrator run`

Date: 2026-06-22

## Intent

Slim down `packages/cli/src/cli.ts` by moving the `orchestrator run` execution path into its own command module. Preserve behavior exactly. This is a maintainability cleanup, not a product change.

## Scope

Create:

```text
packages/cli/src/commands/run.ts
packages/cli/src/task-labels.ts
```

Update:

```text
packages/cli/src/cli.ts
packages/cli/src/commands/launch.ts
```

## New `commands/run.ts`

Move these out of `cli.ts`:

- `RunOptions`
- `ParentToolTraceMode`
- `ParentRunTaskRequest`
- `ParentRunResult`
- `commandRun`
- `commandRunBackground`
- `executeParentRun`
- `commandRunParentTask`
- `parentRunLaunchPlan`
- `writeRunJsonStreamEvent`

Export:

```ts
export type RunOptions = ...
export type ParentToolTraceMode = "off" | "text" | "jsonl";
export async function commandRun(
  options: RunOptions,
  context: { cliEntryPath: string },
): Promise<void>

export async function commandRunParentTask(
  requestPath: string,
  context: { cliEntryPath: string },
): Promise<void>
```

`executeParentRun` should stay private to `commands/run.ts`.

## Shared Label Helpers

Move these helpers into `packages/cli/src/task-labels.ts`:

```ts
export function workspaceName(workspaceRoot: string): string;
export function summarizeTaskPrompt(prompt: string): string;
```

Then remove the `workspaceName` export from `commands/launch.ts`.

## `cli.ts` Changes

Keep `parseRunOptions` in `cli.ts` for now.

Import from `commands/run.ts`:

```ts
import {
  commandRun,
  commandRunParentTask,
  type ParentToolTraceMode,
  type RunOptions,
} from "./commands/run.ts";
```

Change dispatch:

```ts
await commandRun(parseRunOptions(rest), { cliEntryPath: CLI_ENTRY_PATH });
await commandRunParentTask(parseInternalRunTaskOptions(rest), {
  cliEntryPath: CLI_ENTRY_PATH,
});
```

Remove run-specific imports from `cli.ts` once they are only used by `commands/run.ts`.

## Behavior Requirements

The extraction must preserve:

- foreground plain output
- foreground `--json`
- foreground `--stream-json`
- `--trace-tools=text`
- `--trace-tools=jsonl`
- setup error JSONL behavior for `--stream-json`
- background parent task creation
- parent request cleanup
- parent task launch plan shape
- background task output capture
- all existing validation errors and hints

## Tests

Run:

```bash
pnpm run typecheck
node --experimental-strip-types --test test/cli-run.test.ts test/cli-contract.test.ts
pnpm run check
```

No new behavior tests are required if the extraction is purely mechanical. Add a test only if the extraction reveals an uncovered edge.

## Acceptance Criteria

- `cli.ts` no longer contains parent run execution logic.
- `commands/run.ts` owns run execution.
- `cli.ts` remains the router/parser hub.
- `run --background` still creates an `orchestrator` task.
- `run --stream-json` still emits parseable setup errors on stdout.
- Full check passes.
