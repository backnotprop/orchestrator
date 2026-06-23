# Research Spike: Parser Primitives Extraction

Date: 2026-06-22

## Question

What should the first parser cleanup slice move out of `packages/cli/src/cli.ts`?

## Current Shape

After the command extraction pass, `cli.ts` is about 1,173 lines. It now mostly contains:

- command routing
- parser functions
- parser helper functions
- direct entrypoint detection

The large command execution blocks are already extracted.

Current parser/helper functions in `cli.ts` include:

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
- `defaultCommonOptions`
- `resolveDefaultWorkspaceRoot`
- `findNearestGitRoot`
- `requireValue`
- `parseIntegerOption`
- `parseTaskStatus`
- `parseTaskName`
- `parseLogStream`
- `parseParentToolTraceMode`
- `isDirectEntrypoint`

## Size

Rough line count by parser/helper:

```text
normalizeLeadingCommonOptions   33
parseHelpOptions                45
parseLaunchOptions             156
parseListOptions                39
parsePsOptions                 107
parseReadOptions                90
parseLogsOptions                69
parseEventsOptions              63
parseWatchOptions               50
parseInterruptOptions          100
parseDoctorOptions              51
parseRunOptions                140
small shared helpers            98
```

The repeated common option handling is visible across almost every parser, but this slice should not rewrite parser control flow yet.

## Good First Extraction

Create:

```text
packages/cli/src/parsing/primitives.ts
```

Move command-neutral helpers:

- `CommonOptions`
- `defaultCommonOptions`
- `resolveDefaultWorkspaceRoot`
- `findNearestGitRoot`
- `requireValue`
- `parseIntegerOption`
- `parseTaskStatus`
- `parseTaskName`

These helpers are already shared by many parsers and do not depend on a specific command module.

## What Not To Move Yet

Do not move command-specific parsers in this slice:

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

Also leave these for later:

- `parseLogStream`
- `parseParentToolTraceMode`
- `normalizeLeadingCommonOptions`
- `parseInternalRunTaskOptions`
- `isDirectEntrypoint`

`parseLogStream` is tied to the task-inspection command option type. `parseParentToolTraceMode` is tied to the parent-run command option type. Moving them now would create awkward dependencies from generic parsing code back into command modules, or require moving command-specific option types too early.

`normalizeLeadingCommonOptions` is shared behavior, but it should wait until common option handling is designed. It currently participates in top-level routing and unknown-command behavior.

## Existing Duplication

`cli-error-recovery.ts` has its own `resolveDefaultWorkspaceRoot` and `findNearestGitRoot`. Once `parsing/primitives.ts` exists, that file can import the shared helper and drop its duplicate git-root logic.

That is a good small win for this slice because it removes duplicate behavior without changing command parser structure.

## Tests Covering Behavior

Relevant tests:

- `test/cli-contract.test.ts`
  - common options before commands
  - help parser behavior
  - compact help command args
- `test/cli-errors.test.ts`
  - machine-readable parser/config errors
  - missing option values
  - invalid option values
- `test/cli-launch.test.ts`
  - task name parsing
  - workspace handling
- `test/cli-read.test.ts`
  - numeric option parsing around read/logs
- `test/cli-ps.test.ts`
  - status parsing and ps option behavior

## Risks

The risk is mostly import drift or changing error messages:

- `requireValue` must keep the exact error shape.
- `parseIntegerOption` must keep the exact error shape.
- `parseTaskStatus` must keep using `TASK_STATUSES`.
- `parseTaskName` must keep whitespace collapsing and empty-name rejection.
- `defaultCommonOptions` must keep nearest-git-root behavior.
- `cli-error-recovery.ts` must still resolve workspace/config/orchestrator recovery args the same way.

## Findings

The right first parser cleanup is not full parser extraction. It is a small primitive module that moves command-neutral helper code out of `cli.ts`.

This reduces `cli.ts` modestly and gives later parser cleanup a stable foundation. It also removes duplicate git-root discovery from `cli-error-recovery.ts`.
