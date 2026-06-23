# Research Spike: Common Option Handling

Date: 2026-06-22

## Question

How should the next parser cleanup reduce repeated common option handling without
rewriting the CLI parser?

## Current Shape

`packages/cli/src/cli.ts` is now about 1,099 lines after command extraction and
parser primitive extraction. It still owns:

- top-level routing
- `normalizeLeadingCommonOptions`
- every `parse*Options` function
- command-specific parser helpers

Common parser primitives now live in
`packages/cli/src/parsing/primitives.ts`.

## Repetition Found

The same common option cases are repeated across nearly every command parser:

- `--workspace`
- `--orchestrator-dir`
- `--config`
- `--json`

Current common option case locations:

```text
parseHelpOptions       --json, --workspace, --orchestrator-dir, --config
parseLaunchOptions     --workspace, --orchestrator-dir, --config, --json
parseListOptions       --workspace, --orchestrator-dir, --config, --json
parsePsOptions         --workspace, --orchestrator-dir, --config, --json
parseReadOptions       --workspace, --orchestrator-dir, --config, --json
parseLogsOptions       --workspace, --orchestrator-dir, --config, --json
parseEventsOptions     --workspace, --orchestrator-dir, --config, --json
parseWatchOptions      --workspace, --orchestrator-dir, --config, --json
parseInterruptOptions  --workspace, --orchestrator-dir, --config, --json
parseDoctorOptions     --json, --workspace, --orchestrator-dir, --config
parseRunOptions        --workspace, --orchestrator-dir, --config, --json
```

This is real duplication, but the command parsers are not all equally simple.

## Simple Parser Candidates

Good first candidates:

- `parseHelpOptions`
- `parseListOptions`
- `parseDoctorOptions`
- `parseWatchOptions`

These parsers do not have complex positional parsing. They each loop over args,
switch on options, and throw `unknownOptionError` for everything else.

`parseWatchOptions` has one positional task id, but it is still simple enough to
prove the helper without touching the larger task-inspection cluster.

## Important Edge

`parseHelpOptions` accepts `--orchestrator-dir` but does not use it because
`HelpOptions` has no `orchestratorDir`. That behavior should be preserved.

The helper can still parse `--orchestrator-dir` into a local common object. The
help parser should return only the fields `HelpOptions` needs.

## What Should Wait

Do not apply the helper to these yet:

- `parseLaunchOptions`
- `parsePsOptions`
- `parseReadOptions`
- `parseLogsOptions`
- `parseEventsOptions`
- `parseInterruptOptions`
- `parseRunOptions`

Those have more command-specific behavior: positional arguments, `--` handling,
multiple task ids, selector validation, compact/brief dependencies, or trace
mode parsing. They can use the same helper later after it proves itself.

Do not change `normalizeLeadingCommonOptions` in this slice. It handles a
different job: moving global options before the command into the command parser.
It also has special behavior when only global options are passed.

## Helper Shape

Create:

```text
packages/cli/src/parsing/common-options.ts
```

Expected helper shape:

```ts
type CommonOptionParseResult = { matched: true; nextIndex: number } | { matched: false };

function parseCommonOption(
  args: readonly string[],
  index: number,
  common: CommonOptions,
): CommonOptionParseResult;
```

The helper should mutate the existing `common` object. That matches the current
parser style and keeps call sites small:

```ts
const parsed = parseCommonOption(args, index, common);
if (parsed.matched) {
  index = parsed.nextIndex;
  continue;
}
```

For options with values, `nextIndex` should point at the consumed value. For
`--json`, `nextIndex` should be the current index.

## Tests Covering Behavior

Relevant tests:

- `test/cli-contract.test.ts`
  - common options before commands
  - help output and JSON contract
  - doctor compact output
- `test/cli-errors.test.ts`
  - machine-readable parser errors
  - unknown options
  - recovery command args
- `test/cli-launch.test.ts`
  - list workspace behavior
- `test/cli-watch-logs.test.ts`
  - watch parser behavior

## Findings

This should be a small parser cleanup slice. Add a common option parser helper
and use it only in the simple parser candidates. Do not introduce a general
parser framework and do not touch heavy parsers yet.
