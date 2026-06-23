# 0039. Extract Parser Primitives From CLI

Date: 2026-06-22

## Status

Accepted

## Context

The CLI command execution code has been extracted into command modules, but
`packages/cli/src/cli.ts` still owns command routing, all option parsers, and
shared parser helper functions. The file is much smaller than before, but the
next cleanup should avoid a broad parser rewrite.

The parser helpers are a good first slice because they are boring, reused, and
not tied to one command. There is also duplicate git-root workspace discovery in
`packages/cli/src/cli-error-recovery.ts`, which should use the same primitive as
the main parser.

## Decision

Create `packages/cli/src/parsing/primitives.ts` and move the shared parser
primitives there:

- `CommonOptions`
- `defaultCommonOptions`
- `resolveDefaultWorkspaceRoot`
- `findNearestGitRoot`
- `requireValue`
- `parseIntegerOption`
- `parseTaskStatus`
- `parseTaskName`

Update `packages/cli/src/cli.ts` to import these helpers instead of defining
them locally.

Update `packages/cli/src/cli-error-recovery.ts` to import
`resolveDefaultWorkspaceRoot` and remove its duplicate git-root helper logic.

Do not move command-specific parser functions in this slice. Leave
`parseLogStream`, `parseParentToolTraceMode`, `normalizeLeadingCommonOptions`,
`parseInternalRunTaskOptions`, and all `parse*Options` functions in `cli.ts`.

## Consequences

`cli.ts` gets smaller without changing parser flow, command behavior, help text,
JSON contracts, or output.

Parser primitives have a stable home for later parser cleanup.

Workspace defaulting and recovery command generation use the same git-root
resolution logic.

The next parser cleanup can focus on common option handling instead of mixing
that work with primitive extraction.
