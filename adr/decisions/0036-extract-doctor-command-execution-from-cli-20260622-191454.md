# 0036. Extract Doctor Command Execution From CLI

Date: 2026-06-22

## Status

Accepted

## Context

`packages/cli/src/cli.ts` is being reduced by moving command execution into focused command modules. ADR 0031 moved `run`, ADR 0032 moved `read`, `logs`, and `events`, ADR 0033 moved single-task `watch`, ADR 0034 moved `ps`, and ADR 0035 moved `interrupt`.

`orchestrator doctor` is the next coherent command surface left in `cli.ts`. It checks parent-agent readiness, runtime executable availability, compact agent-facing readiness output, and human doctor report rendering.

The lower-level pieces are already in the right places:

- `packages/agent/src/doctor.ts` owns parent-agent config inspection.
- `packages/cli/src/runtime-doctor.ts` owns runtime executable availability checks.

The CLI should not merge those lower-level helpers. It should only move doctor command execution and doctor report shaping out of `cli.ts`.

## Decision

Move `orchestrator doctor` command execution into:

```text
packages/cli/src/commands/doctor.ts
```

That module will own:

- `DoctorOptions`
- `CliDoctorReport`
- `CliCompactDoctorReport`
- `commandDoctor`
- `compactDoctorReport`
- `compactParentRunCommand`
- `hasPiFallbackSuggestion`
- `doctorArgsSuffix`
- `summarizeRuntimeDoctorChecks`
- `renderDoctorReport`

`cli.ts` will keep:

- command dispatch
- `parseDoctorOptions`
- common option parsing
- help text
- JSON help contract
- `doctor --compact requires --json` parser validation

Do not move `runtime-doctor.ts`.

Do not move parent-agent doctor logic from `packages/agent/src/doctor.ts`.

## Consequences

`cli.ts` gets smaller and stops owning doctor command behavior.

`commands/doctor.ts` becomes the home for doctor report construction, compact JSON shaping, human rendering, and exit-code behavior.

The implementation must preserve:

- `doctor`
- `doctor --json`
- `doctor --json --compact`
- `doctor --agent-dir`
- `doctor --session-dir`
- `doctor --workspace`
- `doctor --config`
- accepted but currently unused `--orchestrator-dir`
- `doctor --compact` requiring `--json`
- human report text
- full JSON report shape
- compact JSON report shape
- parent-agent config checks
- runtime availability checks
- config error behavior
- exit code `1` only when report status is `error`
- compact `parent.run.argsPrefix`
- compact `parent.run.backgroundArgsPrefix`
- compact `fullDoctor.args`

Verification should include:

```bash
pnpm run typecheck
node --experimental-strip-types --test test/cli-contract.test.ts test/cli-errors.test.ts test/agent-doctor.test.ts
pnpm run check
```
