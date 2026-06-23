# Synthesis: Help Command Extraction

Date: 2026-06-22

## Summary

`help` should be extracted next.

`ps`, `interrupt`, and `doctor` have already moved into command modules. `help` is the next coherent block because it owns the human help text and the JSON command contract that agents use to understand the CLI.

## What Should Move

Create:

```text
packages/cli/src/commands/help.ts
```

Move into it:

- `HelpOptions`
- `CliHelpDocument`
- `CliCompactHelpDocument`
- `commandHelp`
- `buildCliHelpText`
- `buildCliHelpDocument`
- `compactCliHelpDocument`
- `helpArgsSuffix`
- `orderedRuntimeConfigs`
- `buildCliExamples`

The module should own all help text rendering and all full/compact JSON help shaping.

## What Should Stay

Keep in `cli.ts`:

- `parseHelpOptions`
- command dispatch
- missing-command exit behavior
- unknown-command error handling
- common option normalization
- parser helpers
- `help --compact requires --json` validation

`cli.ts` should still pass `buildCliHelpText` into `unknownCommandError`, but that function should come from the new help module.

## What Should Not Change

Do not change:

- human help wording
- usage lines
- agent instructions
- JSON help schema
- compact JSON help schema
- examples
- workflows
- runtime ordering
- configured runtime loading
- `fullHelp.args`
- implicit help behavior
- unknown-command help fallback
- parser behavior

## Why This Is The Right Next Step

The remaining size in `cli.ts` is now mostly help and parsers. Help is still a product surface with real behavior, so it deserves a focused command module.

Moving help before parser cleanup keeps the refactor controlled. It removes a large static contract block from `cli.ts` while leaving argv parsing centralized until all command execution code is out.

## Expected Outcome

After extraction:

- `cli.ts` is smaller.
- the command contract is easier to maintain in one file.
- `help --json --compact` remains the agent-facing discovery path.
- `cli.ts` still owns command routing and parsing.
- `test/cli-contract.test.ts` remains the main guard against drift.
