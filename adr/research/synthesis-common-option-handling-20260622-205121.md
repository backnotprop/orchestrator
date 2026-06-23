# Synthesis: Common Option Handling

Date: 2026-06-22

## Summary

The next parser cleanup should reduce repeated handling of `--workspace`,
`--orchestrator-dir`, `--config`, and `--json`.

The right move is not a parser framework. It is one small helper that recognizes
common options and updates the existing common options object.

## Decision Direction

Create:

```text
packages/cli/src/parsing/common-options.ts
```

Use it first in:

- `parseHelpOptions`
- `parseListOptions`
- `parseDoctorOptions`
- `parseWatchOptions`

Leave the rest alone for now.

## Why This Slice

The simple parsers are enough to prove the pattern. They already share the same
loop shape and do not need heavy parser restructuring.

The heavier parsers have command-specific logic. Applying a new helper there too
early risks making the parser harder to follow.

## Helper Behavior

The helper should:

- accept `args`, `index`, and a mutable `CommonOptions` object
- handle `--workspace`, `--orchestrator-dir`, `--config`, and `--json`
- use `requireValue` for value options
- resolve path values the same way the current parsers do
- return whether it matched and which index was consumed

## Important Constraint

`help` must keep accepting `--orchestrator-dir` without putting it in
`HelpOptions`. That option is accepted for common-option consistency, but help
does not use the task store.

## Expected Outcome

After this slice:

- common option parsing lives in one helper
- four simple parsers are smaller
- parser behavior stays the same
- `normalizeLeadingCommonOptions` stays untouched
- the heavy parser cleanup remains a later decision
