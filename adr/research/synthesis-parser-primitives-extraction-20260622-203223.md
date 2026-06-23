# Synthesis: Parser Primitives Extraction

Date: 2026-06-22

## Summary

The next cleanup should be a small parser primitives extraction, not a full parser rewrite.

All command execution has now moved out of `cli.ts`. The file is mostly command routing plus parsers. The first parser slice should move only command-neutral helper functions into a shared parsing module.

## What Should Move

Create:

```text
packages/cli/src/parsing/primitives.ts
```

Move:

- `CommonOptions`
- `defaultCommonOptions`
- `resolveDefaultWorkspaceRoot`
- `findNearestGitRoot`
- `requireValue`
- `parseIntegerOption`
- `parseTaskStatus`
- `parseTaskName`

These are shared, boring, and used by many parser functions.

## What Should Stay

Keep in `cli.ts` for now:

- every `parse*Options` function
- `normalizeLeadingCommonOptions`
- `parseInternalRunTaskOptions`
- `parseLogStream`
- `parseParentToolTraceMode`
- `isDirectEntrypoint`

The command parsers should keep their current shape. This slice should not introduce a new parser framework.

## Duplicate To Remove

`cli-error-recovery.ts` duplicates:

- `resolveDefaultWorkspaceRoot`
- `findNearestGitRoot`

After `parsing/primitives.ts` exists, `cli-error-recovery.ts` should import `resolveDefaultWorkspaceRoot` and remove the duplicate helpers.

## Why This Is The Right Slice

This gives us a useful cleanup without changing parser flow. It also creates the place where the next slice can add common option handling.

It is small enough to review and test. It does not require changing command behavior, option behavior, or help contracts.

## Expected Outcome

After this slice:

- `cli.ts` is smaller.
- parser helper code has a stable home.
- duplicate git-root detection is removed.
- command-specific parsers remain explicit and easy to read.
- the next parser slice can focus on common option handling.
