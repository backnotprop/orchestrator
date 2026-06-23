# Spec: Task Inspection Parser Cleanup

Date: 2026-06-22

## Intent

Clean up `read`, `logs`, and `events` parser duplication while keeping each
command parser readable and behavior-preserving.

## Scope

Update:

```text
packages/cli/src/cli.ts
```

Create:

```text
packages/cli/src/parsing/validation.ts
```

Apply cleanup only to:

- `parseReadOptions`
- `parseLogsOptions`
- `parseEventsOptions`

## New Helper

Create `requireJsonForCompact`:

```ts
import { CliError } from "../cli-errors.ts";

export function requireJsonForCompact(command: string, compact: boolean, json: boolean): void {
  if (!compact || json) {
    return;
  }

  throw new CliError(`${command} --compact requires --json.`, {
    reason: "missing_required_option",
    input: "--compact",
    hint: "Add --json or omit --compact.",
  });
}
```

Use this helper in:

- `parseReadOptions`
- `parseLogsOptions`
- `parseEventsOptions`

Do not use it yet in commands with different compact/json hints, such as
`help` and `doctor`.

## Parser Changes

In each target parser, call `parseCommonOption` before the command-specific
switch:

```ts
const commonOption = parseCommonOption(args, index, common);
if (commonOption.matched) {
  index = commonOption.nextIndex;
  continue;
}
```

Remove only the repeated common option cases from those three parsers:

- `--workspace`
- `--orchestrator-dir`
- `--config`
- `--json`

Replace the local compact/json checks with:

```ts
requireJsonForCompact("read", compact, common.json);
requireJsonForCompact("logs", compact, common.json);
requireJsonForCompact("events", compact, common.json);
```

Keep the rest of each parser local.

## Explicitly Out Of Scope

Do not change:

- `parseLaunchOptions`
- `parseListOptions`
- `parsePsOptions`
- `parseWatchOptions`
- `parseInterruptOptions`
- `parseDoctorOptions`
- `parseRunOptions`
- `normalizeLeadingCommonOptions`
- command execution in `commands/task-inspection.ts`
- help text
- JSON contracts
- command output
- error messages

Do not create a shared task-inspection parser loop.

Do not move `parseLogStream`, `missingTaskIdError`, or `duplicateTaskIdError` in
this slice.

Do not abstract `--max-bytes` yet.

## Behavior Requirements

Preserve:

- `read` accepting multiple task ids
- `read` requiring a task id
- `read` requiring `--json` for multiple task ids
- `read --compact` requiring `--json`
- `read --timeout-ms` requiring `--wait`
- `read --interval-ms` requiring `--wait`
- `logs` requiring exactly one task id
- `logs --compact` requiring `--json`
- `logs --stream` validation
- `logs --follow` behavior
- `events` requiring exactly one task id
- `events --compact` requiring `--json`
- `events --agent-only`
- common options before commands
- command-local common options overriding leading common options
- missing common option value errors
- unknown option errors per command

## Verification

Run:

```bash
pnpm run typecheck
node --experimental-strip-types --test test/cli-read.test.ts test/cli-watch-logs.test.ts test/cli-interrupt.test.ts test/cli-errors.test.ts test/cli-contract.test.ts
pnpm run check
```

## Acceptance Criteria

- `parseReadOptions`, `parseLogsOptions`, and `parseEventsOptions` use
  `parseCommonOption`.
- Those three parsers no longer repeat the four common option switch cases.
- Those three parsers use `requireJsonForCompact`.
- Task id parsing remains explicit.
- `parseLogStream` remains local.
- Existing CLI behavior and error messages are unchanged.
- Full check passes.
