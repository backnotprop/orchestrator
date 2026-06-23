# 0033. Extract Watch Command Execution From CLI

Date: 2026-06-22

## Status

Accepted

## Context

`packages/cli/src/cli.ts` is still too large and still owns some command execution logic.

ADR 0031 moved `orchestrator run` execution into a command module. ADR 0032 moved `orchestrator read`, `orchestrator logs`, and `orchestrator events` execution into `commands/task-inspection.ts`.

`orchestrator watch` is the next clean extraction target. It is related to task inspection, but it is live-stream oriented rather than snapshot oriented. It follows one task until exit, reads appended event/stdout/stderr files, renders human task events, and emits raw task JSONL when requested.

ADR 0032 already moved shared helpers out of `cli.ts`:

- `readNewFileText` in `packages/cli/src/task-output.ts`
- `parseTaskEventLine` in `packages/cli/src/task-events.ts`
- `isAgentEventLine` in `packages/cli/src/task-events.ts`

That makes `watch` ready to extract without duplicating file reading or event parsing.

## Decision

Move `orchestrator watch` execution into:

```text
packages/cli/src/commands/watch.ts
```

That module will own:

- `WatchOptions`
- `commandWatch`
- `renderWatchEvents`
- `formatWatchEvent`
- `eventDataString`
- local polling delay

`cli.ts` will keep:

- command dispatch
- `parseWatchOptions`
- help text
- JSON help contract
- parser error behavior

Do not extract `ps --watch` in this decision. It belongs to the grouped operations view, not the single-task watch command.

Do not change the watch output format. This is a behavior-preserving refactor.

## Consequences

`cli.ts` becomes smaller and stops owning single-task live watch execution.

`commands/watch.ts` becomes the home for following one task until it exits.

The existing shared helpers remain in place:

- task event parsing stays in `task-events.ts`
- appended file reads stay in `task-output.ts`

The implementation must preserve:

- short task id prefix resolution
- `--workspace` and `--orchestrator-dir` task store behavior
- `--interval-ms` polling behavior
- human stdout/stderr behavior
- `jsonl_events` stdout suppression in human mode
- `--json` task-event JSONL behavior
- `--agent-only --json` filtering
- partial event-line buffering and final flush
- existing parser error shapes

Verification should include:

```bash
pnpm run typecheck
node --experimental-strip-types --test test/cli-watch-logs.test.ts test/cli-contract.test.ts
pnpm run check
```
