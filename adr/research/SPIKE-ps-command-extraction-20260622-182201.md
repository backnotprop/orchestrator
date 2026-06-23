# Research Spike: Ps Command Extraction

Date: 2026-06-22

## Question

What is required to extract `orchestrator ps` from `packages/cli/src/cli.ts` without changing CLI behavior?

## Current Shape

`ps` is still implemented in `packages/cli/src/cli.ts`.

Current local pieces:

- `PsOptions`
- `commandPs`
- `loadPsView`
- `validatePsRuntimeFilter`
- `formatPsJsonView`
- `withPortableStopArgs`
- `appendGroupControlCommandArgs`
- `appendControlCommandArgs`
- `appendStopArgs`
- `viewArgsSuffix`
- `filterPsViewByParent`
- `resolvePsGroupId`
- `psRowGroupId`

`parsePsOptions` also lives in `cli.ts`. It handles:

- `--workspace`
- `--orchestrator-dir`
- `--config`
- `--json`
- `--status`
- `--runtime`
- `--parent`
- `--all`
- `-A` / `--all-workspaces`
- `--cwd`
- `--watch` / `-w`
- `--compact`
- `--brief`
- `--active`
- `--interval-ms`

## Runtime Behavior

`commandPs` has two paths:

- normal snapshot
- `--watch` loop

Snapshot behavior:

- validates `--runtime` against configured runtime ids or historical task runtime ids
- builds an `AgentTaskPsView`
- optionally filters to one parent/group
- prints human table output through `renderPsView`
- prints JSON through `jsonLine`
- prints compact JSON through `compactAgentTaskPsView` plus portable follow-up command args

Watch behavior:

- repeatedly builds the same view
- prints compact JSON frames as one JSON object per line when `--json` is set
- redraws in place when stdout is a TTY
- prints full frames with `---` separators when stdout is not a TTY
- sleeps for `intervalMs` between frames

## Existing Adjacent Modules

`packages/cli/src/render-ps.ts` already owns human table rendering.

`packages/cli/src/terminal-frame.ts` already owns TTY frame redraw helpers:

- `renderWatchFrame`
- `countRenderedLines`
- `terminalColumns`

`packages/cli/src/ps-view-commands.ts` already owns the base compact ps view command args.

`packages/cli/src/task-output.ts` already exports `stopArgsSuffix`, which is used to make returned task commands portable across custom task stores.

These should stay as separate helper modules. The new ps command module should import them rather than folding them into itself.

## Tests Covering Behavior

`test/cli-ps.test.ts` covers the core behavior:

- human grouped operations view
- JSON rows
- unique short task id prefixes
- compact machine-control JSON
- compact validation errors
- parent/group filtering
- ambiguous parent/group errors
- compact ids with old hidden tasks
- `ps --watch`
- `ps --watch --json --compact --active`
- readable nested JSON runtime errors

Other relevant tests:

- `test/cli-launch.test.ts` covers workspace filtering and portable compact ps commands
- `test/cli-errors.test.ts` covers machine-readable ps option errors and recovery views
- `test/cli-read.test.ts` covers invalid status/runtime behavior used by ps
- `test/cli-contract.test.ts` covers help and command-contract references

## Extraction Risk

The extraction is medium risk, not because the code is hard, but because `ps` has many output contracts.

Main things to preserve:

- compact JSON shape
- compact JSON one-line behavior
- `--watch --json` frame behavior
- non-TTY `ps --watch` frame separator behavior
- TTY redraw behavior
- parent/group prefix resolution
- ambiguous group error metadata
- runtime filter validation
- portable args for task commands, group commands, and view commands
- `--all-workspaces`, `--workspace`, `--cwd`, `--orchestrator-dir`, and `--config` propagation

The biggest sharp edge is the portable args logic. Group commands use both task suffixes and view suffixes:

- task commands need `--orchestrator-dir`
- view commands need workspace/cwd/config scope

That logic should move with `formatPsJsonView`, not be split in this slice.

## Recommendation

Create:

```text
packages/cli/src/commands/ps.ts
```

Move into it:

- `PsOptions`
- `commandPs`
- `loadPsView`
- `validatePsRuntimeFilter`
- `formatPsJsonView`
- compact portable command helpers
- parent/group filter helpers
- local polling delay for `ps --watch`

Keep in `cli.ts`:

- `parsePsOptions`
- command dispatch
- help text and JSON help contract
- generic parsing helpers

Do not move:

- `render-ps.ts`
- `terminal-frame.ts`
- `ps-view-commands.ts`
- `parseTaskStatus`
- common option parsing helpers

This keeps the slice mechanical and behavior-preserving.
