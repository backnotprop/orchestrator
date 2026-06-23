# Research Spike: Help Command Extraction

Date: 2026-06-22

## Question

What is required to extract `orchestrator help` and the CLI command contract out of `packages/cli/src/cli.ts` without changing behavior?

## Current Shape

`help` is still implemented directly in `cli.ts`.

The current help-owned pieces are:

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

`parseHelpOptions` also lives in `cli.ts`, with the rest of the command parsers.

The default command path and unknown-command path both depend on help:

- `help`, `--help`, and `-h` call `commandHelp(parseHelpOptions(rest))`
- missing command prints help but exits `1`
- unknown command errors receive `buildCliHelpText` so the error can show human help

## Current Command Behavior

`commandHelp` loads the configured runtime registry for the selected workspace and optional config file.

It prints one of three surfaces:

1. Human help text.
2. Full JSON command contract with `--json`.
3. Compact JSON command contract with `--json --compact`.

The full JSON contract contains:

- `schemaVersion`
- `purpose`
- `agentInstructions`
- configured enabled runtimes
- command usage, semantics, and options
- workflows
- examples

The compact JSON contract contains:

- `schemaVersion`
- `purpose`
- `fullHelp.args`
- `agentQuickStart`
- `canLaunchChildAgents`
- compact runtime rows
- compact command rows
- selected examples

## Runtime Registry Behavior

Human help and JSON help should reflect the configured runtime registry, not only built-ins.

This matters for:

- disabled built-in runtimes
- custom process agents
- explicit `--config <path>`
- workspace-level `orchestrator.config.json`

`orderedRuntimeConfigs` currently lists enabled built-ins first, then enabled custom runtimes sorted by id.

## Tests Covering Behavior

Relevant tests live mostly in `test/cli-contract.test.ts`.

They cover:

- human help usage lines
- human help examples
- runtime ids in human help
- full JSON help schema
- agent instructions
- all command contract entries
- workflows
- examples
- implicit JSON help from `orchestrator --json`
- compact JSON help schema
- compact `fullHelp.args`
- compact runtime ids after disabling built-ins and adding custom agents
- compact output omitting full workflows and full agent instructions
- compact help fetching full help through returned args
- `help --compact` requiring `--json`
- explicit `--config` preservation in compact help returned args

## Extraction Boundary

Good extraction target:

```text
packages/cli/src/commands/help.ts
```

Move help command execution and command-contract construction into that module.

Keep in `cli.ts` for now:

- command dispatch
- `parseHelpOptions`
- common option normalization
- common parser helpers
- `help --compact requires --json` validation
- missing-command exit behavior
- unknown-command error routing

After extraction, `cli.ts` should import both `commandHelp` and `buildCliHelpText` from the help command module.

## Risks

The main risk is changing the command contract that agents read through `help --json` or `help --json --compact`.

Specific risks:

- changing `fullHelp.args`
- dropping `--workspace` or `--config` from compact follow-up args
- changing the enabled runtime list
- changing examples that tests and docs expect
- breaking implicit help through `orchestrator --json`
- breaking unknown-command help fallback
- accidentally moving parser cleanup into the same slice

## Findings

`help` is now ready to extract. Earlier command modules are stable enough that the command contract can move without blocking on ongoing command refactors.

The extraction should be mechanical:

- create `commands/help.ts`
- export `HelpOptions`
- export `commandHelp`
- export `buildCliHelpText`
- move the help document types and helper functions there
- import those exports in `cli.ts`
- leave `parseHelpOptions` in `cli.ts`
- preserve all text and JSON output exactly

This is the last large command-contract block in `cli.ts`. Parser cleanup should still wait until after this extraction.
