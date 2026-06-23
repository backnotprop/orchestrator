# 0034. Extract Ps Command Execution From CLI

Date: 2026-06-22

## Status

Accepted

## Context

`packages/cli/src/cli.ts` is still too large after extracting `launch`, `run`, `read`, `logs`, `events`, and single-task `watch`.

`orchestrator ps` is now the largest coherent command block left in `cli.ts`. It owns grouped task views, compact machine-control JSON, parent/group filtering, runtime validation, portable follow-up commands, and live `ps --watch`.

The command already relies on focused helper modules:

- `render-ps.ts` for human ps table rendering
- `terminal-frame.ts` for TTY redraw behavior
- `ps-view-commands.ts` for base compact ps view commands
- `task-output.ts` for task-store suffix helpers

Those helper modules should stay separate. The extraction should move ps command execution, not rewrite rendering or command contracts.

## Decision

Move `orchestrator ps` execution into:

```text
packages/cli/src/commands/ps.ts
```

That module will own:

- `PsOptions`
- `commandPs`
- `loadPsView`
- `validatePsRuntimeFilter`
- `formatPsJsonView`
- portable command arg helpers
- parent/group filtering helpers
- ps-local polling delay for `ps --watch`

`cli.ts` will keep:

- command dispatch
- `parsePsOptions`
- help text
- JSON help contract
- parser error behavior
- generic parser helpers such as `parseTaskStatus`

Do not extract or change:

- `render-ps.ts`
- `terminal-frame.ts`
- `ps-view-commands.ts`
- compact ps JSON contracts
- returned command args
- `ps --watch` behavior

## Consequences

`cli.ts` becomes smaller and stops owning the largest remaining command execution block.

`commands/ps.ts` becomes the home for ps snapshot and ps watch behavior.

The implementation must preserve:

- human grouped operations output
- full ps JSON output
- compact ps JSON output
- compact view `views.active`, `views.recent`, and `views.all`
- portable args for view commands, group commands, task commands, and stop targets
- parent/group prefix resolution
- ambiguous parent/group error metadata and hints
- unknown runtime validation behavior
- workspace, cwd, all-workspaces, config, and orchestrator-dir scoping
- `ps --watch` TTY redraw behavior
- `ps --watch` non-TTY frame separator behavior
- `ps --watch --json` one-line frame behavior

Verification should include:

```bash
pnpm run typecheck
node --experimental-strip-types --test test/cli-ps.test.ts test/cli-launch.test.ts test/cli-errors.test.ts test/cli-contract.test.ts
pnpm run check
```
