# Spec: Extract `help`

Date: 2026-06-22

## Intent

Continue shrinking `packages/cli/src/cli.ts` without changing CLI behavior. Extract `orchestrator help`, human help text, and the JSON command contract into a dedicated command module.

## Scope

Create:

```text
packages/cli/src/commands/help.ts
```

Update:

```text
packages/cli/src/cli.ts
```

No wording, schema, runtime registry, command parser, or error-routing changes should be included in this slice.

## New Command Module

`packages/cli/src/commands/help.ts` should export:

```ts
export type HelpOptions = {
  workspaceRoot: string;
  configPath?: string;
  json: boolean;
  compact: boolean;
};

export async function commandHelp(options: HelpOptions): Promise<void>;

export function buildCliHelpText(registry?: RuntimeRegistry): string;
```

The module should own these private types:

- `CliHelpDocument`
- `CliCompactHelpDocument`

The module should own these private helpers:

- `buildCliHelpDocument`
- `compactCliHelpDocument`
- `helpArgsSuffix`
- `orderedRuntimeConfigs`
- `buildCliExamples`

## `cli.ts` Changes

Import:

```ts
import { buildCliHelpText, commandHelp, type HelpOptions } from "./commands/help.ts";
```

Remove from `cli.ts`:

- local `HelpOptions`
- local `CliHelpDocument`
- local `CliCompactHelpDocument`
- local `commandHelp`
- local `buildCliHelpText`
- local `buildCliHelpDocument`
- local `compactCliHelpDocument`
- local `helpArgsSuffix`
- local `orderedRuntimeConfigs`
- local `buildCliExamples`
- help-only imports from `@backnotprop/orchestrator-core`
- help-only import of `jsonLine`

Keep in `cli.ts`:

- `parseHelpOptions`
- command dispatch
- missing-command exit behavior
- unknown-command error handling
- common parser helpers
- `help --compact requires --json` validation

`unknownCommandError` should continue to receive `buildCliHelpText`.

## Behavior Requirements

Preserve:

- `orchestrator help`
- `orchestrator --help`
- `orchestrator -h`
- implicit help through no command
- implicit JSON help through `orchestrator --json`
- unknown-command help fallback
- `help --json`
- `help --json --compact`
- `help --workspace <path>`
- `help --config <path>`
- accepted but ignored `--orchestrator-dir`
- `help --compact` requiring `--json`
- human help text
- full JSON command contract
- compact JSON command contract
- runtime ordering and filtering
- custom runtime visibility
- disabled runtime exclusion
- `fullHelp.args`
- agent instructions
- workflows
- examples

## Dependencies In `help.ts`

Expected core imports:

```ts
import {
  ALL_AGENT_RUNTIMES,
  BUILT_IN_AGENT_RUNTIMES,
  loadConfiguredRuntimeRegistry,
  type HeadlessAgentRuntimeConfig,
  type RuntimeRegistry,
} from "@backnotprop/orchestrator-core";
```

Expected CLI imports:

```ts
import { jsonLine } from "../json-output.ts";
```

`cli.ts` should keep `getRuntimeConfig` and `RuntimeRegistry` only if still needed by `list` rendering.

## Verification

Run:

```bash
pnpm run typecheck
node --experimental-strip-types --test test/cli-contract.test.ts test/cli-errors.test.ts
pnpm run check
```

`test/cli-contract.test.ts` is the main guard. It protects human help, full JSON help, compact JSON help, examples, workflows, runtime config behavior, and compact follow-up args.

## Acceptance Criteria

- `cli.ts` no longer owns help command execution.
- `cli.ts` no longer owns help text or JSON help document construction.
- `cli.ts` still owns `parseHelpOptions`.
- `commands/help.ts` owns the human help renderer and command-contract builders.
- Existing help text, JSON, compact JSON, and error behavior are unchanged.
- Full check passes.
