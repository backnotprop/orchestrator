# Synthesis: Run Command Extraction

Date: 2026-06-22

## Recommendation

Extract the `run` execution path first, then come back for parser cleanup.

The best first move is:

```text
packages/cli/src/commands/run.ts
```

That file should own:

- `RunOptions`
- `ParentToolTraceMode`
- `ParentRunTaskRequest`
- `ParentRunResult`
- `commandRun`
- `commandRunParentTask`
- `executeParentRun`
- `commandRunBackground`
- `parentRunLaunchPlan`
- `writeRunJsonStreamEvent`

`cli.ts` should keep:

- top-level command dispatch
- `parseRunOptions`
- `parseParentToolTraceMode`

This keeps the first patch small and behavior-preserving.

## Required Shared Helper Cleanup

Before or during the extraction, move generic label helpers out of command files:

```text
packages/cli/src/task-labels.ts
```

It should own:

- `workspaceName(workspaceRoot)`
- `summarizeTaskPrompt(prompt)`

Then:

- `commands/launch.ts` imports `workspaceName` from `task-labels.ts`
- `commands/run.ts` imports `workspaceName` and `summarizeTaskPrompt`
- `cli.ts` imports `summarizeTaskPrompt` if list rendering still needs it

This avoids making `run` depend on `launch`.

## Command Context

`run` needs the CLI entry path for detached child processes. Follow the same pattern as `launch`:

```ts
commandRun(options, { cliEntryPath });
commandRunParentTask(requestPath, { cliEntryPath });
```

Do not let `commands/run.ts` compute `fileURLToPath(import.meta.url)` itself. `cli.ts` should remain the owner of the actual executable entrypoint path.

## What Not To Do Yet

Do not extract all parsers in this patch.

Do not move parent agent code into `core`. The parent run command is still CLI-specific because it writes to stdout/stderr, depends on the CLI entry path, and starts detached Node processes.

Do not change the stream event contract, trace rendering, background task shape, or parent task request schema.

## Expected Result

This should remove a meaningful block from `cli.ts` without risky architectural churn. It will leave `cli.ts` as the command router plus parser hub for now, which is acceptable until the next parser-focused cleanup.
