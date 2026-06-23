# SPIKE: Heavy Parser Cleanup

Date: 2026-06-23

## Question

How should we clean up the remaining heavy parsers in `packages/cli/src/cli.ts`
without changing CLI behavior?

Target parsers:

- `parseLaunchOptions`
- `parsePsOptions`
- `parseInterruptOptions`
- `parseRunOptions`

## Current State

The earlier parser cleanup created these reusable pieces:

- `packages/cli/src/parsing/primitives.ts`
  - `CommonOptions`
  - `defaultCommonOptions`
  - `resolveDefaultWorkspaceRoot`
  - `findNearestGitRoot`
  - `requireValue`
  - `parseIntegerOption`
  - `parseTaskStatus`
  - `parseTaskName`
- `packages/cli/src/parsing/common-options.ts`
  - `parseCommonOption`
- `packages/cli/src/parsing/validation.ts`
  - `requireJsonForCompact`

The simple parsers and task-inspection parsers already use these helpers. The
four heavy parsers still repeat common option handling inline.

Current parser sizes:

- `parseLaunchOptions`: 155 lines
- `parseRunOptions`: 139 lines
- `parsePsOptions`: 106 lines
- `parseInterruptOptions`: 83 lines

Total target area: 483 lines.

## Parser Findings

### `parseLaunchOptions`

Launch is the best first target. It repeats common options but the command rules
are still easy to follow.

Behavior to preserve:

- `--` stops option parsing and appends the rest to task text.
- the first non-option argument is `runtime`.
- later non-option arguments become task text.
- `-f` / `--file` switches to manifest mode.
- manifest launch rejects positional runtime/task.
- manifest launch rejects `--wait`.
- manifest launch rejects `--name`.
- manifest launch requires `--json`.
- non-manifest launch requires runtime and task text.
- `--compact` requires `--json`.
- `--brief` requires `--compact`.
- `--allow-disabled-runtime` stays launch-only.

Risk:

- `parseCommonOption` must run after the `--` sentinel check and before runtime
  detection. Otherwise `--workspace <path>` could be mistaken for task text or
  runtime input.
- `launch -f` JSON validation must keep its specific error message. Do not
  replace it with generic compact validation.

### `parsePsOptions`

`ps` is command-specific but not positional. It is mostly a switch over filters
and display modes.

Behavior to preserve:

- `--status` uses `parseTaskStatus`.
- `--runtime` is a raw runtime id/prefix string.
- `--parent` is a raw parent id/prefix string.
- `--all`, `-A` / `--all-workspaces`, `--watch`, `--compact`, `--brief`,
  `--active`, and `--interval-ms` stay local.
- `--cwd` is resolved against the final `common.workspaceRoot` after parsing.
- `--compact` requires `--json`.
- `--active` requires `--compact`.
- `--brief` requires `--compact`.

Risk:

- `--cwd` must remain raw during parsing, then resolve against the final
  workspace. This preserves behavior when `--cwd` appears before `--workspace`.

### `parseInterruptOptions`

Interrupt is the most safety-sensitive parser because selector combinations
control process cancellation.

Behavior to preserve:

- positional non-option args become `taskIds`.
- `--parent`, `--group`, and `--active` are selectors.
- `--children` and `--task-only` stay task-control modifiers.
- `-A` / `--all-workspaces` requires `--yes` when combined with `--active`.
- `--reason` and `--signal` keep their current parsing.
- selector validation remains in `validateInterruptOptions`.

Risk:

- Do not spread interrupt validation back into `cli.ts`.
- Do not duplicate `interrupt --compact requires --json` if
  `validateInterruptOptions` remains the owner.
- Common option parsing should be the only mechanical parser cleanup here.

### `parseRunOptions`

Run is special because it starts the parent agent. It also supports foreground
streaming, background task mode, trace tools, and JSON result modes.

Behavior to preserve:

- `--` stops option parsing and appends the rest to the request text.
- non-option arguments become request text.
- `--agent-dir` and `--session-dir` resolve immediately.
- `--name` uses `parseTaskName`.
- `--trace-tools` defaults to text mode.
- `--trace-tools=<mode>` uses `parseParentToolTraceMode`.
- `--stream-json` cannot combine with `--json`.
- `--compact` requires `--json`.
- `--brief` requires `--compact`.
- `--compact` requires `--background`.
- `--background` cannot combine with `--trace-tools`.
- `--background` cannot combine with `--stream-json`.
- `--name` requires `--background`.

Risk:

- Keep run-specific compact validation local because the hint differs from the
  generic compact/json helper.
- `parseParentToolTraceMode` should remain local for this slice.

## Test Coverage Found

Relevant tests already exist:

- `test/cli-launch.test.ts`
- `test/cli-batch-launch.test.ts`
- `test/cli-ps.test.ts`
- `test/cli-interrupt.test.ts`
- `test/cli-run.test.ts`
- `test/cli-errors.test.ts`
- `test/cli-contract.test.ts`

These cover compact/json errors, batch launch mode, ps active/brief behavior,
interrupt selector safety, and run foreground/background conflicts.

## Conclusion

Clean up all four heavy parsers in one implementation goal, but do it in four
internal loops:

1. launch
2. ps
3. interrupt
4. run

Each loop should apply `parseCommonOption`, preserve command-specific behavior,
run focused tests, then move to the next parser.
