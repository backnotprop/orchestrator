# Spec: Heavy Parser Cleanup

Date: 2026-06-23

## Intent

Clean up the four remaining heavy CLI parsers in one implementation goal while
preserving command behavior.

Target parsers:

- `parseLaunchOptions`
- `parsePsOptions`
- `parseInterruptOptions`
- `parseRunOptions`

## Scope

Update:

```text
packages/cli/src/cli.ts
```

Use existing helpers:

```text
packages/cli/src/parsing/common-options.ts
packages/cli/src/parsing/validation.ts
```

No new parser framework is planned for this slice.

## Required Approach

Do the work in four internal passes:

1. update `parseLaunchOptions`
2. update `parsePsOptions`
3. update `parseInterruptOptions`
4. update `parseRunOptions`

After each pass, run the relevant focused tests before continuing.

## Common Option Handling

In each target parser, call `parseCommonOption` before the command-specific
switch.

For parsers with a `--` sentinel, check the sentinel first:

```ts
if (arg === "--") {
  // append the remaining args to task/request text
  break;
}

const commonOption = parseCommonOption(args, index, common);
if (commonOption.matched) {
  index = commonOption.nextIndex;
  continue;
}
```

Remove repeated common option cases from the target parsers:

- `--workspace`
- `--orchestrator-dir`
- `--config`
- `--json`

## `parseLaunchOptions`

Apply `parseCommonOption` after the `--` sentinel check and before runtime
detection.

Use `requireJsonForCompact("launch", compact, common.json)` only for the normal
`launch --compact requires --json` rule.

Keep manifest-specific JSON validation local:

```text
launch -f requires --json.
```

Preserve all current launch behavior:

- first non-option argument is `runtime`
- remaining non-option arguments become task text
- `--` appends the remaining args to task text
- `-f` / `--file` manifest mode
- manifest mode rejects positional runtime/task
- manifest mode rejects `--wait`
- manifest mode rejects `--name`
- manifest mode requires `--json`
- normal launch requires runtime
- normal launch requires task instructions
- `--brief` requires `--compact`
- `--allow-disabled-runtime` remains local

Focused verification:

```bash
node --experimental-strip-types --test test/cli-launch.test.ts test/cli-batch-launch.test.ts test/cli-contract.test.ts
```

## `parsePsOptions`

Apply `parseCommonOption` before the `ps` switch.

Use `requireJsonForCompact("ps", compact, common.json)`.

Preserve all current ps behavior:

- no positional args
- `--status` uses `parseTaskStatus`
- `--runtime` remains a raw runtime filter string
- `--parent` remains a raw parent id/prefix string
- `--all`
- `-A` / `--all-workspaces`
- `--cwd`
- `--watch` / `-w`
- `--compact`
- `--brief`
- `--active`
- `--interval-ms`
- `--active` requires `--compact`
- `--brief` requires `--compact`

Keep `--cwd` as a raw value during parsing and resolve it in the returned object
against the final `common.workspaceRoot`.

Focused verification:

```bash
node --experimental-strip-types --test test/cli-ps.test.ts test/cli-errors.test.ts test/cli-contract.test.ts
```

## `parseInterruptOptions`

Apply `parseCommonOption` before the interrupt switch.

Do not move or duplicate interrupt validation. Keep returning
`validateInterruptOptions(...)`.

Preserve all current interrupt behavior:

- positional non-option args become `taskIds`
- `--parent`
- `--group`
- `--active`
- `-A` / `--all-workspaces`
- `--yes`
- `--children`
- `--task-only`
- `--reason`
- `--signal`
- `--compact`
- selector validation stays in `validateInterruptOptions`

Do not use `requireJsonForCompact` here unless interrupt compact validation is
also moved out of `validateInterruptOptions`. This slice should not do that.

Focused verification:

```bash
node --experimental-strip-types --test test/cli-interrupt.test.ts test/cli-errors.test.ts test/cli-contract.test.ts
```

## `parseRunOptions`

Apply `parseCommonOption` after the `--` sentinel check and before the run
switch.

Do not use `requireJsonForCompact` for run. Keep the current run-specific error
hints.

Preserve all current run behavior:

- `--` appends the remaining args to request text
- non-option args become request text
- `--agent-dir`
- `--session-dir`
- `--name`
- `--background`
- `--compact`
- `--brief`
- `--trace-tools`
- `--trace-tools=<mode>`
- `--stream-json`
- empty request is rejected before mode validation
- `--stream-json` cannot combine with `--json`
- `--compact` requires `--json`
- `--brief` requires `--compact`
- `--compact` requires `--background`
- `--background` cannot combine with `--trace-tools`
- `--background` cannot combine with `--stream-json`
- `--name` requires `--background`

Focused verification:

```bash
node --experimental-strip-types --test test/cli-run.test.ts test/cli-errors.test.ts test/cli-contract.test.ts
```

## Out Of Scope

Do not:

- create a full parser framework
- move parser functions into separate files
- move `parseParentToolTraceMode`
- move interrupt selector validation
- merge launch task parsing with run request parsing
- change help text
- change JSON contracts
- change command output
- change command execution modules

## Final Verification

After all four internal passes:

```bash
pnpm run typecheck
node --experimental-strip-types --test test/cli-launch.test.ts test/cli-batch-launch.test.ts test/cli-ps.test.ts test/cli-interrupt.test.ts test/cli-run.test.ts test/cli-errors.test.ts test/cli-contract.test.ts
pnpm run check
git diff --check
```

## Acceptance Criteria

- all four target parsers use `parseCommonOption`
- repeated common option switch cases are removed from the four target parsers
- launch and ps use `requireJsonForCompact` only for matching compact/json
  validation
- interrupt validation remains in `validateInterruptOptions`
- run validation keeps run-specific hints
- command-specific parser flow remains readable
- focused tests pass after each internal parser pass
- full check passes at the end
