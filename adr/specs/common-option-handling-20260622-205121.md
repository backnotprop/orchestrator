# Spec: Common Option Handling

Date: 2026-06-22

## Intent

Reduce repeated common option parsing in `cli.ts` without rewriting the command
parsers. Prove the pattern on simple parsers first.

## Scope

Create:

```text
packages/cli/src/parsing/common-options.ts
```

Update:

```text
packages/cli/src/cli.ts
```

Apply the helper only to:

- `parseHelpOptions`
- `parseListOptions`
- `parseDoctorOptions`
- `parseWatchOptions`

## New Helper

`packages/cli/src/parsing/common-options.ts` should export:

```ts
import { resolve } from "node:path";
import { type CommonOptions, requireValue } from "./primitives.ts";

export type CommonOptionParseResult = { matched: true; nextIndex: number } | { matched: false };

export function parseCommonOption(
  args: readonly string[],
  index: number,
  common: CommonOptions,
): CommonOptionParseResult;
```

Behavior:

- `--workspace <path>` sets `common.workspaceRoot = resolve(value)`.
- `--orchestrator-dir <path>` sets `common.orchestratorDir = resolve(value)`.
- `--config <path>` sets `common.configPath = resolve(value)`.
- `--json` sets `common.json = true`.
- unknown options return `{ matched: false }`.
- missing values still throw the same `CliError` from `requireValue`.

For value options, `nextIndex` should be the index of the consumed value. For
`--json`, `nextIndex` should be the original option index.

## Parser Changes

In each target parser, replace the four common option switch cases with:

```ts
const commonOption = parseCommonOption(args, index, common);
if (commonOption.matched) {
  index = commonOption.nextIndex;
  continue;
}
```

Then keep command-specific switch cases exactly where they are.

`parseHelpOptions` should switch from separate local variables to a local common
object:

```ts
const common = defaultCommonOptions();
```

It should still return only the `HelpOptions` fields:

```ts
return {
  workspaceRoot: common.workspaceRoot,
  ...(common.configPath ? { configPath: common.configPath } : {}),
  json: common.json,
  compact,
};
```

This preserves the current behavior where help accepts `--orchestrator-dir` but
does not use it.

## Explicitly Out Of Scope

Do not change:

- `normalizeLeadingCommonOptions`
- `parseLaunchOptions`
- `parsePsOptions`
- `parseReadOptions`
- `parseLogsOptions`
- `parseEventsOptions`
- `parseInterruptOptions`
- `parseRunOptions`
- command output
- help text
- JSON contracts
- error messages

Do not introduce a full parser framework.

## Behavior Requirements

Preserve:

- common options before commands
- command-local common options overriding leading common options
- missing common option value errors
- unknown option errors per command
- `help --compact` requiring `--json`
- `doctor --compact` requiring `--json`
- watch task id parsing and duplicate task id errors
- list status parsing and workspace filtering

## Verification

Run:

```bash
pnpm run typecheck
node --experimental-strip-types --test test/cli-contract.test.ts test/cli-errors.test.ts test/cli-launch.test.ts test/cli-watch-logs.test.ts
pnpm run check
```

## Acceptance Criteria

- `packages/cli/src/parsing/common-options.ts` exists.
- The helper handles the four common options.
- `parseHelpOptions`, `parseListOptions`, `parseDoctorOptions`, and
  `parseWatchOptions` use the helper.
- Heavy parsers are not changed.
- Existing CLI behavior and errors are unchanged.
- Full check passes.
