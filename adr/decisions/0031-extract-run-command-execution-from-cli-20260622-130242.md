# 0031. Extract Run Command Execution From CLI

Date: 2026-06-22

## Status

Accepted

## Context

`packages/cli/src/cli.ts` is still too large. Earlier cleanup moved launch execution, background task launching, and task output formatting into smaller files, but `cli.ts` still owns the full `orchestrator run` path.

The `run` command is one of the heavier remaining blocks. It includes foreground parent-agent execution, background parent task setup, internal parent-task execution, stream JSON output, tool trace output, and parent run launch-plan construction.

The code research found that this logic is cohesive enough to extract without changing behavior. The parser should stay in `cli.ts` for now because the command parsers still share common parsing helpers that have not been extracted yet.

## Decision

Move the `orchestrator run` execution path into:

```text
packages/cli/src/commands/run.ts
```

That module will own:

- `RunOptions`
- `ParentToolTraceMode`
- `ParentRunTaskRequest`
- `ParentRunResult`
- `commandRun`
- `commandRunBackground`
- `executeParentRun`
- `commandRunParentTask`
- `parentRunLaunchPlan`
- `writeRunJsonStreamEvent`

`cli.ts` will keep top-level command dispatch and `parseRunOptions` for this slice.

The run command module will receive the CLI entry path from `cli.ts`:

```ts
commandRun(options, { cliEntryPath });
commandRunParentTask(requestPath, { cliEntryPath });
```

It must not compute the executable entry path itself.

Move generic task label helpers into:

```text
packages/cli/src/task-labels.ts
```

That file will own:

- `workspaceName(workspaceRoot)`
- `summarizeTaskPrompt(prompt)`

This avoids making `commands/run.ts` depend on `commands/launch.ts` for generic naming logic.

## Consequences

`cli.ts` becomes smaller and less responsible for parent-agent execution details.

`commands/run.ts` becomes the owner of the parent run lifecycle, including foreground runs, background parent tasks, run stream output, and trace output.

This is a behavior-preserving refactor. It must not change the stream event contract, trace output contract, background task shape, parent task request schema, or validation behavior.

Parser extraction remains a later cleanup. After this decision is implemented, `cli.ts` will still be a router and parser hub, but it will no longer own the run execution internals.
