# Spec: Parser Function Extraction

Date: 2026-06-23

## Intent

Move command parser functions out of `packages/cli/src/cli.ts` so `cli.ts`
becomes mostly the executable entrypoint, command router, and top-level error
handler.

## Scope

Move these functions out of `cli.ts`:

- `normalizeLeadingCommonOptions`
- `parseHelpOptions`
- `parseLaunchOptions`
- `parseListOptions`
- `parsePsOptions`
- `parseReadOptions`
- `parseLogsOptions`
- `parseEventsOptions`
- `parseWatchOptions`
- `parseInterruptOptions`
- `parseDoctorOptions`
- `parseRunOptions`
- `parseInternalRunTaskOptions`
- `parseLogStream`
- `parseParentToolTraceMode`
- `missingTaskIdError`
- `duplicateTaskIdError`

Keep this in `cli.ts`:

- `main`
- `CLI_ENTRY_PATH`
- route switch
- catch/error formatting
- `isDirectEntrypoint`

## Target Files

Create:

```text
packages/cli/src/parsing/leading-common-options.ts
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
packages/cli/src/parsing/task-id-errors.ts
```

Keep:

```text
packages/cli/src/parsing/primitives.ts
packages/cli/src/parsing/common-options.ts
packages/cli/src/parsing/validation.ts
```

## Module Rules

Parser files may import:

- command option types from `../commands/*.ts`
- `CliError` and `unknownOptionError` from `../cli-errors.ts`
- shared parser helpers from `./*.ts`
- `resolve` from `node:path` where needed
- `TaskStatus` from `@backnotprop/orchestrator-core` only if needed

Parser files must not import from `../cli.ts`.

Command modules must not import parser files.

Option types stay in command modules.

## Extraction Passes

### Pass 1: Leading Common Options

Move:

- `normalizeLeadingCommonOptions`

To:

```text
packages/cli/src/parsing/leading-common-options.ts
```

Focused verification:

```bash
node --experimental-strip-types --test test/cli-contract.test.ts test/cli-errors.test.ts
```

### Pass 2: Small Parsers

Move:

- `parseHelpOptions`
- `parseListOptions`
- `parseDoctorOptions`
- `parseInternalRunTaskOptions`

To:

```text
packages/cli/src/parsing/help.ts
packages/cli/src/parsing/list.ts
packages/cli/src/parsing/doctor.ts
packages/cli/src/parsing/internal.ts
```

Focused verification:

```bash
node --experimental-strip-types --test test/cli-contract.test.ts test/cli-errors.test.ts
```

### Pass 3: Shared Task ID Errors

Move:

- `missingTaskIdError`
- `duplicateTaskIdError`

To:

```text
packages/cli/src/parsing/task-id-errors.ts
```

Focused verification:

```bash
node --experimental-strip-types --test test/cli-read.test.ts test/cli-watch-logs.test.ts test/cli-errors.test.ts
```

### Pass 4: Task Inspection and Watch Parsers

Move:

- `parseReadOptions`
- `parseLogsOptions`
- `parseEventsOptions`
- `parseLogStream`
- `parseWatchOptions`

To:

```text
packages/cli/src/parsing/task-inspection.ts
packages/cli/src/parsing/watch.ts
```

`parseLogStream` should stay inside `task-inspection.ts` unless another parser
needs it later.

Focused verification:

```bash
node --experimental-strip-types --test test/cli-read.test.ts test/cli-watch-logs.test.ts test/cli-errors.test.ts test/cli-contract.test.ts
```

### Pass 5: Heavy Parsers

Move:

- `parseLaunchOptions`
- `parsePsOptions`
- `parseInterruptOptions`
- `parseRunOptions`
- `parseParentToolTraceMode`

To:

```text
packages/cli/src/parsing/launch.ts
packages/cli/src/parsing/ps.ts
packages/cli/src/parsing/interrupt.ts
packages/cli/src/parsing/run.ts
```

`parseParentToolTraceMode` should stay inside `run.ts`.

Focused verification:

```bash
node --experimental-strip-types --test test/cli-launch.test.ts test/cli-batch-launch.test.ts test/cli-ps.test.ts test/cli-interrupt.test.ts test/cli-run.test.ts test/cli-errors.test.ts test/cli-contract.test.ts
```

## Behavior Requirements

Preserve all current behavior:

- leading common options still normalize before routing
- command-local common options still override leading common options
- `launch` and `run` still honor `--` before common option parsing
- launch positional runtime/task behavior stays unchanged
- launch manifest validation stays unchanged
- `ps --cwd` still resolves against the final workspace
- interrupt selector validation stays in `validateInterruptOptions`
- run trace and background validation stays unchanged
- help text stays unchanged
- JSON contracts stay unchanged
- command output stays unchanged
- error messages stay unchanged

## Final Verification

Run:

```bash
pnpm run typecheck
node --experimental-strip-types --test test/cli-launch.test.ts test/cli-batch-launch.test.ts test/cli-ps.test.ts test/cli-interrupt.test.ts test/cli-run.test.ts test/cli-read.test.ts test/cli-watch-logs.test.ts test/cli-errors.test.ts test/cli-contract.test.ts
pnpm run check
git diff --check
```

## Acceptance Criteria

- `cli.ts` no longer defines per-command parser functions.
- `cli.ts` imports parser functions from `packages/cli/src/parsing/*`.
- parser files mirror command files or command clusters.
- parser files do not import from `cli.ts`.
- command modules do not import parser files.
- option types remain in command modules.
- full check passes.
