# Synthesis: Interrupt Command Extraction

Date: 2026-06-22

## Summary

`interrupt` should be extracted next.

The code already has the right architecture: core owns interruption semantics, and CLI owns user-facing command behavior. The extraction should preserve that line.

## What Should Move

Create:

```text
packages/cli/src/commands/interrupt.ts
```

Move the interrupt command execution into it:

- `InterruptOptions`
- `commandInterrupt`
- `interruptTargetFromOptions`
- `isSingleTaskInterrupt`
- `printInterruptTasksResult`

Also move interrupt-specific validation:

- `validateInterruptOptions`
- `interruptSelectors`
- `interruptSelectorError`
- `incompatibleInterruptOptionsError`

This keeps the command behavior and its safety checks together.

## What Should Stay

Keep in `cli.ts`:

- dispatch for `interrupt`
- `parseInterruptOptions`
- common option parsing
- help text
- JSON help document
- generic parser helpers

The parser should create the options object, then call:

```ts
return validateInterruptOptions(options);
```

This keeps the current parser-cleanup strategy intact while still moving interrupt-specific rules out of `cli.ts`.

## What Should Not Change

Do not change:

- core `interruptTasks`
- parent/child safety rules
- group resolution
- active task selection
- `--active` / `-A --yes` behavior
- full JSON shape
- compact JSON shape
- human output
- single-task non-JSON output
- exit code behavior
- help text or examples

## Why This Is The Right Next Step

`ps` is now extracted. `interrupt` is the next coherent product command left in `cli.ts`.

It matters because this is budget-control behavior. It is what humans and agents use to stop stale work, parent runs, child groups, and active tasks. It deserves to live in a focused command module.

## Expected Outcome

After extraction:

- `cli.ts` gets smaller.
- interrupt behavior is easier to read and test.
- parser cleanup remains a later phase.
- command behavior stays unchanged.

Verification should run the interrupt tests, the CLI contract tests, and the full check.
