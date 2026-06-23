# Research Spike: Watch Command Extraction

Date: 2026-06-22

## Question

What is required to extract `orchestrator watch` from `packages/cli/src/cli.ts` without changing CLI behavior?

## Current Shape

`watch` is still implemented in `packages/cli/src/cli.ts`.

Current local pieces:

- `WatchOptions`
- `commandWatch`
- `parseWatchOptions`
- `renderWatchEvents`
- `formatWatchEvent`
- `eventDataString`

The command dispatch is:

```ts
case "watch":
  await commandWatch(parseWatchOptions(rest));
  return 0;
```

`parseWatchOptions` is normal CLI argument parsing. It handles:

- `--workspace`
- `--orchestrator-dir`
- `--config`
- `--json`
- `--agent-only`
- `--interval-ms`
- one task id or unique prefix

## Runtime Behavior

`commandWatch`:

- builds task store options from `workspaceRoot` and optional `orchestratorDir`
- resolves the task id or prefix through `resolveTaskId`
- loops until the task reaches a terminal status
- reads appended task events from `events.jsonl`
- reads appended stdout and stderr
- renders task events as JSONL when `--json` is set
- renders human event lines when `--json` is not set
- suppresses raw stdout for structured `jsonl_events` transports in human mode
- suppresses stderr in JSON mode
- flushes any partial event line when the task exits
- sleeps for `intervalMs` between polls

## Shared Helpers Already Prepared

ADR 0032 already moved the right shared helpers out of `cli.ts`:

- `readNewFileText` lives in `packages/cli/src/task-output.ts`
- `parseTaskEventLine` lives in `packages/cli/src/task-events.ts`
- `isAgentEventLine` lives in `packages/cli/src/task-events.ts`

This means the watch extraction does not need to duplicate file tailing or event parsing.

## Dependencies

The extracted command needs:

From `@backnotprop/orchestrator-core`:

- `isTerminalTaskStatus`
- `readTaskRecord`
- `resolveTaskId`
- `TaskEvent` type

From CLI modules:

- `readNewFileText` from `task-output.ts`
- `isAgentEventLine`, `parseTaskEventLine` from `task-events.ts`
- `formatInline` from `terminal-format.ts`

It should not need:

- help rendering
- option parsing
- ps rendering
- logs/read/events payload builders
- task inspection command internals

## Tests Covering Behavior

`test/cli-watch-logs.test.ts` covers the critical behavior:

- `watch` follows a running task and prints raw stdout plus lifecycle events
- `watch --json` emits only parseable task events
- `watch --json` does not leak raw provider stdout/stderr
- `watch --agent-only --json` streams only normalized agent events
- `logs --follow` remains separate and points users to `watch --json` for parseable live events

`test/cli-contract.test.ts` covers help/contract references for `watch`.

## Extraction Risk

The extraction is low risk if it is mechanical.

Main things to preserve:

- task id prefix resolution
- exact stdout/stderr behavior in JSON and non-JSON modes
- `jsonl_events` stdout suppression in human mode
- partial event-line buffering
- final partial-line flush on terminal task status
- default interval of 250 ms from the parser
- current error shapes from parser and task lookup

The only mild risk is moving `formatWatchEvent`, because it is human rendering logic. It should move with `commandWatch` so the extracted command owns its full runtime behavior.

## Recommendation

Create:

```text
packages/cli/src/commands/watch.ts
```

Move into it:

- `WatchOptions`
- `commandWatch`
- `renderWatchEvents`
- `formatWatchEvent`
- `eventDataString`
- local `delay`

Keep in `cli.ts`:

- `parseWatchOptions`
- command dispatch
- help text and command contract text

This matches the extraction pattern already used for `launch`, `run`, and `read/logs/events`.
