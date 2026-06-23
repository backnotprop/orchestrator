# Research Spike: Doctor Command Extraction

Date: 2026-06-22

## Question

What is required to extract `orchestrator doctor` out of `packages/cli/src/cli.ts` without changing behavior?

## Current Shape

`doctor` is still fully implemented in `cli.ts`.

The current `cli.ts` doctor-owned pieces are:

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

`parseDoctorOptions` also lives in `cli.ts`, with the rest of the command parsers.

## Current Command Behavior

`commandDoctor` does two checks:

1. Parent-agent config readiness through `doctorParentAgentConfig`.
2. Runtime executable availability through `doctorRuntimeAvailability`.

It then combines both into a CLI report:

- parent agent doctor fields
- `runtimeSummary`
- `runtimes`

Output behavior:

- without `--json`, render human text through `renderDoctorReport`
- with `--json`, render the full report
- with `--json --compact`, render a smaller report for agents and scripts
- return exit code `1` when parent-agent status is `error`, otherwise `0`

## Current Compact Contract

Compact doctor output includes:

- `schemaVersion`
- `status`
- `canRunParentAgent`
- `canLaunchChildAgents`
- `parent.canRun`
- `parent.agentDir`
- `parent.sessionDir`
- optional `parent.piAgentDir`
- optional `parent.run`
- `runtimeSummary`
- compact runtime availability rows
- `fullDoctor.args`

`parent.run` is included when either:

- parent agent config is ready, or
- Pi fallback config exists and the parent doctor suggests using it

The returned run command prefixes are intentionally portable:

- `parent.run.argsPrefix`
- `parent.run.backgroundArgsPrefix`

`fullDoctor.args` currently includes `--workspace`, optional `--config`, optional `--agent-dir`, and optional `--session-dir`. It does not include `--orchestrator-dir`, because doctor does not use the task store today.

## Tests Covering Behavior

Relevant tests live mostly in `test/cli-contract.test.ts`:

- doctor appears in text help
- JSON help documents doctor and compact doctor
- doctor reports parent-agent config paths
- doctor reports configured runtime availability
- compact doctor reports small portable runtime readiness
- compact doctor exposes parent run prefixes for Pi fallback config
- `doctor --compact` without `--json` fails with the current error message and hint

Additional error coverage lives in `test/cli-errors.test.ts`:

- bad config JSON fails through `doctor --json`
- unsupported custom agent adapter fails through `doctor --json`
- invalid output config fails through `doctor --json`

Lower-level parent-agent doctor behavior lives in `test/agent-doctor.test.ts`.

## Extraction Boundary

Good extraction target:

```text
packages/cli/src/commands/doctor.ts
```

Move doctor command execution and report shaping into that module.

Keep in `cli.ts` for now:

- command dispatch
- `parseDoctorOptions`
- compact-without-json parser validation
- help text
- JSON help contract
- common option parsing

Do not move `doctorRuntimeAvailability` yet. It already lives in a focused helper file:

```text
packages/cli/src/runtime-doctor.ts
```

Do not move `doctorParentAgentConfig`. It belongs to the parent-agent package:

```text
packages/agent/src/doctor.ts
```

## Risks

The main risk is changing the compact doctor contract. Agents can use `doctor --json --compact` to discover if parent run is available and which command args to use.

Another risk is accidentally changing config error routing. `doctor` loads the runtime registry, so custom runtime config errors currently surface through doctor. That should remain true.

The smallest behavioral risk is changing human text formatting. The renderer should move as-is.

## Findings

`doctor` is a clean extraction target. It is self-contained, smaller than `ps`, and less cross-cutting than help.

The right move is mechanical:

- create `commands/doctor.ts`
- export `DoctorOptions`
- move the report types and command helpers there
- import `commandDoctor` and `DoctorOptions` in `cli.ts`
- leave `parseDoctorOptions` and help in `cli.ts`
- keep `runtime-doctor.ts` as-is

This continues the command extraction pattern without starting parser cleanup early.
