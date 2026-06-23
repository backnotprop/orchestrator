# SPIKE: Run Command Extraction

Date: 2026-06-22

## Question

How should we extract `orchestrator run` out of `packages/cli/src/cli.ts` without changing behavior?

## Current Shape

`cli.ts` still owns the whole `run` path:

- `RunOptions`, `ParentToolTraceMode`, `ParentRunTaskRequest`, `ParentRunResult`
- `commandRun`
- `commandRunBackground`
- `executeParentRun`
- `commandRunParentTask`
- `parentRunLaunchPlan`
- `writeRunJsonStreamEvent`
- `parseRunOptions`
- `parseParentToolTraceMode`

The dispatch path is:

```text
main
  -> parseRunOptions
  -> commandRun
```

Foreground run:

```text
commandRun
  -> executeParentRun
    -> createRunStreamSequencer
    -> createOrchestratorParentSession
    -> session.prompt(buildOrchestratorParentPrompt(request))
    -> session.getLastAssistantText()
    -> session.dispose()
```

Background run:

```text
commandRun
  -> commandRunBackground
    -> writeParentRunRequest
    -> parentRunLaunchPlan
    -> launchInBackground
      -> __run-parent-task
        -> commandRunParentTask
          -> executeParentRun
```

## Behavior To Preserve

- Foreground plain output prints only the final parent answer, plus model fallback warnings on stderr.
- `--json` prints one final JSON object.
- `--stream-json` writes JSONL run events to stdout.
- `--trace-tools=text` renders readable trace events to stderr.
- `--trace-tools=jsonl` writes raw parent tool trace events to stderr.
- `--background` creates a managed `orchestrator` task and cannot combine with trace or stream JSON.
- `--name`, `--compact`, and `--brief` are background-only controls.
- Internal parent task requests are removed in a `finally` block.
- Parent task stdout/stderr remains captured by the normal task supervisor.

## Current Couplings

`run` currently pulls several run-specific dependencies into `cli.ts`:

- parent session creation from `@backnotprop/orchestrator-agent`
- run stream sequencing and normalization
- parent prompt building
- background task request writing
- background child launching
- run trace rendering
- parent launch plan construction

It also uses two generic helpers that should not live in the launch command:

- `workspaceName`
- `summarizeTaskPrompt`

`workspaceName` is currently exported from `commands/launch.ts`, which would make a future `commands/run.ts` depend on the launch command for a generic label helper. That is the wrong dependency direction.

## Tests Covering This Area

`test/cli-run.test.ts` covers:

- missing request validation
- `--json` and `--stream-json` conflict
- stream JSON setup errors
- invalid trace mode
- `--name` outside background
- compact/brief guards
- `run --background` managed parent task behavior

`test/cli-contract.test.ts` also checks help output for `run`, trace, stream JSON, and background usage.

## Finding

The extraction is straightforward if we split execution before parsing. The run execution path is cohesive enough to move into `packages/cli/src/commands/run.ts`. The parser can remain in `cli.ts` for the first patch because it depends on common CLI parsing helpers that are still shared by every command.

Trying to move `parseRunOptions` first would force a broader parser-helper extraction. That is doable, but it is not required to reduce the main monolith safely.
