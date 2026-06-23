# 0037. Extract Help Command Contract From CLI

Date: 2026-06-22

## Status

Accepted

## Context

`packages/cli/src/cli.ts` has already had the `run`, task inspection, `watch`, `ps`, `interrupt`, and `doctor` command execution paths extracted into command modules. The remaining large command block is `help`.

`help` is not only human text. It is also the command contract that agents and scripts use through `help --json` and `help --json --compact`. It describes runtimes, workflows, examples, command usage, and portable follow-up args.

Keeping this contract inside `cli.ts` makes the entrypoint harder to maintain and mixes command routing with a large static/document-building surface.

## Decision

Extract `orchestrator help` into:

```text
packages/cli/src/commands/help.ts
```

The new module will own:

- `HelpOptions`
- `commandHelp`
- `buildCliHelpText`
- full JSON help document construction
- compact JSON help document construction
- human help rendering
- runtime ordering for help output
- help examples and workflow text

`cli.ts` will keep:

- `parseHelpOptions`
- command dispatch
- missing-command exit behavior
- unknown-command error handling
- common parser helpers
- `help --compact requires --json` validation

`unknownCommandError` will continue to receive `buildCliHelpText`, but the function will be imported from the new help command module.

This extraction must preserve the current human help text, full JSON help schema, compact JSON help schema, examples, workflows, runtime ordering, `fullHelp.args`, implicit help behavior, and parser behavior.

## Consequences

`cli.ts` gets smaller and remains focused on routing and parsing.

The agent-facing command contract becomes easier to maintain in one file.

The extraction must be mechanical. It should not rename fields, rewrite help language, change command examples, or start parser cleanup.

`test/cli-contract.test.ts` remains the main guard for behavior drift, with `test/cli-errors.test.ts` covering error behavior around help and config loading.
