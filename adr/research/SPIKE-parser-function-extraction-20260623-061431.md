# SPIKE: Parser Function Extraction

Date: 2026-06-23

## Question

Should the remaining parser functions move out of `packages/cli/src/cli.ts`, and
if so, what file layout preserves behavior without making the code harder to
follow?

## Current State

`packages/cli/src/cli.ts` is now about 1000 lines. Command execution has already
moved to `packages/cli/src/commands/*`. The remaining bulk in `cli.ts` is
command routing plus parser functions.

Current parser functions in `cli.ts`:

- `normalizeLeadingCommonOptions`: 31 lines
- `parseHelpOptions`: 36 lines
- `parseLaunchOptions`: 143 lines
- `parseListOptions`: 32 lines
- `parsePsOptions`: 94 lines
- `parseReadOptions`: 77 lines
- `parseLogsOptions`: 56 lines
- `parseEventsOptions`: 50 lines
- `parseWatchOptions`: 43 lines
- `parseInterruptOptions`: 77 lines
- `parseDoctorOptions`: 44 lines
- `parseRunOptions`: 133 lines
- `parseInternalRunTaskOptions`: 7 lines
- `parseLogStream`: 10 lines
- `parseParentToolTraceMode`: 10 lines

Total parser/helper area is roughly 810 lines.

Existing shared parser helpers:

- `packages/cli/src/parsing/primitives.ts`
- `packages/cli/src/parsing/common-options.ts`
- `packages/cli/src/parsing/validation.ts`

## Dependency Findings

### Routing

`main` calls parser functions directly, then passes typed options into command
modules. That split is good:

- `cli.ts`: route command names
- parser functions: turn argv into typed options
- command modules: execute behavior

Moving parser functions should preserve that split.

### Option Types

Option types already live with command modules:

- `commands/launch.ts` exports `LaunchOptions`
- `commands/ps.ts` exports `PsOptions`
- `commands/interrupt.ts` exports `InterruptOptions`
- `commands/run.ts` exports `RunOptions`
- etc.

The parser modules should import those types. Do not move option types into
parser files. Command modules should not depend on parser files.

### Shared Parser Helpers

Most parsers depend on:

- `defaultCommonOptions`
- `parseCommonOption`
- `requireValue`
- `parseIntegerOption`
- `unknownOptionError`
- sometimes `CliError`
- sometimes `requireJsonForCompact`

These are stable enough to use from parser modules.

### Shared Task ID Errors

`read`, `logs`, `events`, and `watch` share task-id errors:

- `missingTaskIdError`
- `duplicateTaskIdError`

If `watch` and task inspection are split into separate parser files, these
should move into a small shared parser file rather than being duplicated.

Suggested file:

```text
packages/cli/src/parsing/task-id-errors.ts
```

### `parseLogStream`

Only `logs` uses `parseLogStream`. It can move with task inspection parsing.

### `parseParentToolTraceMode`

Only `run` uses `parseParentToolTraceMode`. It can move with run parsing.

### Leading Common Options

`normalizeLeadingCommonOptions` runs before command routing. It is parser
behavior, not command execution.

Suggested file:

```text
packages/cli/src/parsing/leading-common-options.ts
```

## Layout Options

### Option A: One `parsing/options.ts`

Put every parser into one file.

Pros:

- one import point
- small change to `cli.ts`

Cons:

- recreates a large file elsewhere
- harder to review command-specific parser changes
- not aligned with command modules

Verdict: not recommended.

### Option B: One parser file per command or command cluster

Mirror command modules:

```text
packages/cli/src/parsing/help.ts
packages/cli/src/parsing/launch.ts
packages/cli/src/parsing/list.ts
packages/cli/src/parsing/ps.ts
packages/cli/src/parsing/task-inspection.ts
packages/cli/src/parsing/watch.ts
packages/cli/src/parsing/interrupt.ts
packages/cli/src/parsing/doctor.ts
packages/cli/src/parsing/run.ts
packages/cli/src/parsing/internal.ts
packages/cli/src/parsing/leading-common-options.ts
packages/cli/src/parsing/task-id-errors.ts
```

Pros:

- maps cleanly to `commands/*`
- keeps command-specific parsing readable
- keeps `cli.ts` focused on routing
- avoids a parser monolith

Cons:

- more files
- more imports in `cli.ts`

Verdict: recommended.

### Option C: Put parser next to command modules

Example:

```text
packages/cli/src/commands/launch.ts
```

would export both `commandLaunch` and `parseLaunchOptions`.

Pros:

- command behavior and parser are colocated
- fewer top-level folders

Cons:

- command modules become larger again
- mixes argv parsing with execution behavior
- partially reverses the command extraction cleanup

Verdict: not recommended for this repo.

## Recommended Extraction Order

Do the extraction in small internal passes:

1. Move `normalizeLeadingCommonOptions`.
2. Move small parsers:
   - help
   - list
   - doctor
   - internal
3. Move task id error helpers.
4. Move task inspection and watch parsers:
   - read
   - logs
   - events
   - watch
5. Move heavy parsers:
   - launch
   - ps
   - interrupt
   - run
6. Remove parser helper imports from `cli.ts` once no longer needed.

## Risks

- Import cycles if parser files import from `cli.ts`. Parser files must not
  import from `cli.ts`.
- Behavior drift in sentinel parsing for `launch` and `run`.
- Behavior drift in `ps --cwd`, which must still resolve against the final
  workspace.
- Behavior drift in interrupt selector validation if validation moves
  accidentally. It should not move.
- Too many tiny files if helper extraction is overdone.

## Conclusion

Move parser functions out of `cli.ts` into parser files that mirror command
modules. Keep command modules as the owners of option types and execution
behavior. Keep `cli.ts` as the entrypoint, route table, error wrapper, and direct
entrypoint check.
