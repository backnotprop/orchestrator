# Spec: Extract `doctor`

Date: 2026-06-22

## Intent

Continue shrinking `packages/cli/src/cli.ts` without changing CLI behavior. Extract `orchestrator doctor` into its own command module.

## Scope

Create:

```text
packages/cli/src/commands/doctor.ts
```

Update:

```text
packages/cli/src/cli.ts
```

No parent-agent doctor, runtime registry, runtime availability, help text, or parser cleanup should be included in this slice.

## New Command Module

`packages/cli/src/commands/doctor.ts` should export:

```ts
export type DoctorOptions = {
  workspaceRoot: string;
  orchestratorDir?: string;
  configPath?: string;
  json: boolean;
  agentDir?: string;
  sessionDir?: string;
  compact: boolean;
};

export async function commandDoctor(options: DoctorOptions): Promise<number>;
```

The module should own these private types:

- `CliDoctorReport`
- `CliCompactDoctorReport`

The module should own these private helpers:

- `compactDoctorReport`
- `compactParentRunCommand`
- `hasPiFallbackSuggestion`
- `doctorArgsSuffix`
- `summarizeRuntimeDoctorChecks`
- `renderDoctorReport`

## `cli.ts` Changes

Import:

```ts
import { commandDoctor, type DoctorOptions } from "./commands/doctor.ts";
```

Remove from `cli.ts`:

- local `DoctorOptions`
- local `CliDoctorReport`
- local `CliCompactDoctorReport`
- local `commandDoctor`
- local compact doctor helpers
- local doctor human renderer
- doctor-only imports from `@backnotprop/orchestrator-agent`
- doctor-only import of `RuntimeDoctorCheck`
- doctor-only import of `doctorRuntimeAvailability`

Keep in `cli.ts`:

- `parseDoctorOptions`
- command dispatch
- help text
- JSON help contract
- common parser helpers
- `doctor --compact requires --json` validation

## Behavior Requirements

Preserve:

- `doctor`
- `doctor --json`
- `doctor --json --compact`
- `doctor --agent-dir <path>`
- `doctor --session-dir <path>`
- `doctor --workspace <path>`
- `doctor --config <path>`
- accepted but currently unused `--orchestrator-dir`
- `doctor --compact` requiring `--json`
- human report text
- full JSON report shape
- compact JSON report shape
- parent-agent config checks
- runtime availability checks
- custom runtime config errors surfacing through doctor
- exit code `1` only when report status is `error`
- compact `parent.run.argsPrefix`
- compact `parent.run.backgroundArgsPrefix`
- compact `fullDoctor.args`

## Dependencies In `doctor.ts`

Expected imports:

```ts
import {
  doctorParentAgentConfig,
  type ParentAgentDoctorReport,
} from "@backnotprop/orchestrator-agent";
import { loadConfiguredRuntimeRegistry } from "@backnotprop/orchestrator-core";
import { jsonLine } from "../json-output.ts";
import { doctorRuntimeAvailability, type RuntimeDoctorCheck } from "../runtime-doctor.ts";
```

Do not move `runtime-doctor.ts` in this slice.

## Verification

Run:

```bash
pnpm run typecheck
node --experimental-strip-types --test test/cli-contract.test.ts test/cli-errors.test.ts test/agent-doctor.test.ts
pnpm run check
```

`test/cli-contract.test.ts` is the main doctor CLI guard. `test/cli-errors.test.ts` protects config error behavior. `test/agent-doctor.test.ts` protects lower-level parent-agent doctor behavior.

## Acceptance Criteria

- `cli.ts` no longer owns doctor command execution.
- `cli.ts` still owns `parseDoctorOptions`.
- `commands/doctor.ts` owns doctor report construction, compact JSON shaping, human rendering, and exit-code behavior.
- `runtime-doctor.ts` remains separate.
- `packages/agent/src/doctor.ts` remains separate.
- Existing doctor text, JSON, compact JSON, and exit behavior are unchanged.
- Full check passes.
