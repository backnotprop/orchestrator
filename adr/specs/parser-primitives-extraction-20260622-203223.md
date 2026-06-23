# Spec: Extract Parser Primitives

Date: 2026-06-22

## Intent

Start parser cleanup with the lowest-risk slice. Move shared parser primitives out of `cli.ts` without changing command parser structure or CLI behavior.

## Scope

Create:

```text
packages/cli/src/parsing/primitives.ts
```

Update:

```text
packages/cli/src/cli.ts
packages/cli/src/cli-error-recovery.ts
```

Do not change command option parsing flow, help text, JSON contracts, command execution, or output behavior.

## New Module

`packages/cli/src/parsing/primitives.ts` should export:

```ts
export type CommonOptions = {
  workspaceRoot: string;
  orchestratorDir?: string;
  configPath?: string;
  json: boolean;
};

export function defaultCommonOptions(): CommonOptions;
export function resolveDefaultWorkspaceRoot(cwd: string): string;
export function findNearestGitRoot(start: string): string | undefined;
export function requireValue(args: readonly string[], index: number, option: string): string;
export function parseIntegerOption(value: string, option: string): number;
export function parseTaskStatus(value: string, option: string): TaskStatus;
export function parseTaskName(value: string): string;
```

## `cli.ts` Changes

Import the primitives:

```ts
import {
  defaultCommonOptions,
  parseIntegerOption,
  parseTaskName,
  parseTaskStatus,
  requireValue,
  resolveDefaultWorkspaceRoot,
  type CommonOptions,
} from "./parsing/primitives.ts";
```

Remove from `cli.ts`:

- local `CommonOptions`
- local `defaultCommonOptions`
- local `resolveDefaultWorkspaceRoot`
- local `findNearestGitRoot`
- local `requireValue`
- local `parseIntegerOption`
- local `parseTaskStatus`
- local `parseTaskName`
- imports used only by those helpers

Keep in `cli.ts`:

- every `parse*Options` function
- `normalizeLeadingCommonOptions`
- `parseInternalRunTaskOptions`
- `parseLogStream`
- `parseParentToolTraceMode`
- `isDirectEntrypoint`
- `CliError` import, because command-specific parser validation still uses it
- `unknownOptionError`, because command-specific parsers still use it

## `cli-error-recovery.ts` Changes

Import:

```ts
import { resolveDefaultWorkspaceRoot } from "./parsing/primitives.ts";
```

Remove duplicate local helpers:

- `resolveDefaultWorkspaceRoot`
- `findNearestGitRoot`

Remove imports used only by those helpers.

## Explicitly Out Of Scope

Do not move yet:

- `parseLogStream`
- `parseParentToolTraceMode`
- `normalizeLeadingCommonOptions`
- `parseInternalRunTaskOptions`
- any `parse*Options` function

Do not add yet:

- a generic parser framework
- common option dispatch helpers
- command-specific parser modules

Those belong to later slices.

## Behavior Requirements

Preserve:

- nearest-git-root default workspace behavior
- missing option value errors
- positive integer option errors
- task status validation and error text
- task name whitespace normalization
- empty task name error
- parser behavior for every command
- recovery command workspace resolution
- help and JSON command contracts

## Verification

Run:

```bash
pnpm run typecheck
node --experimental-strip-types --test test/cli-contract.test.ts test/cli-errors.test.ts test/cli-launch.test.ts test/cli-read.test.ts test/cli-ps.test.ts
pnpm run check
```

`test/cli-contract.test.ts` protects common option behavior and command contracts. `test/cli-errors.test.ts` protects parser error shapes and recovery JSON. The command-specific tests protect the helpers in real use.

## Acceptance Criteria

- `cli.ts` no longer defines the parser primitive helpers.
- `cli.ts` still owns the command-specific parser functions.
- `cli-error-recovery.ts` no longer duplicates git-root detection.
- `packages/cli/src/parsing/primitives.ts` owns the shared parser primitives.
- Existing parser behavior and errors are unchanged.
- Full check passes.
