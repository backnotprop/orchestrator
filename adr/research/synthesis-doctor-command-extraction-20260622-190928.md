# Synthesis: Doctor Command Extraction

Date: 2026-06-22

## Summary

`doctor` should be extracted next.

`ps` and `interrupt` are now out of `cli.ts`. `doctor` is the next coherent command surface because it owns parent-agent readiness, runtime availability, compact JSON readiness output, and human report rendering.

## What Should Move

Create:

```text
packages/cli/src/commands/doctor.ts
```

Move into it:

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

This makes the doctor module the owner of doctor execution and report shaping.

## What Should Stay

Keep in `cli.ts`:

- `parseDoctorOptions`
- command dispatch
- help text
- JSON help document
- common parsing helpers
- `doctor --compact requires --json` parser validation

Keep in place:

- `packages/cli/src/runtime-doctor.ts`
- `packages/agent/src/doctor.ts`

Those are already focused lower-level helpers. The extraction should not merge them into the command module.

## What Should Not Change

Do not change:

- human doctor output
- full doctor JSON output
- compact doctor JSON output
- `parent.run.argsPrefix`
- `parent.run.backgroundArgsPrefix`
- `fullDoctor.args`
- runtime availability checks
- parent-agent config checks
- exit code behavior
- config error behavior
- help text or examples

## Why This Is The Right Next Step

`doctor` is important, but contained. It is a product surface, not a parser concern. Moving it gives us a smaller `cli.ts` without taking on the risk of moving `help` yet.

`help` should stay later because it references every command contract. Parser cleanup should also stay later because command extraction is not done.

## Expected Outcome

After extraction:

- `cli.ts` gets smaller.
- doctor behavior is easier to read in one place.
- runtime doctor helper remains reusable.
- parent-agent doctor remains in the agent package.
- all current doctor tests continue to pass.
