# Successful Background Parent Events

Date: 2026-06-30

## Goal

Close the remaining confidence gap for persisted background parent events by
testing a successful parent run, not only a setup failure.

## Scope

This is a verification and testability slice. Product behavior should not change.

In scope:

- add a private test seam for parent-session creation;
- add a deterministic successful parent-run integration test;
- optionally add an opt-in live smoke test or documented smoke command;
- update the backlog checklist if the test proves the feature.

Out of scope:

- no new public CLI flag;
- no new event store;
- no TUI work;
- no Pi transcript persistence;
- no changes to child task storage;
- no runtime adapter changes.

## Implementation Plan

1. Add a narrow parent-session factory seam.

   In `packages/cli/src/commands/run.ts`, extend the command context:

   ```ts
   type RunCommandContext = {
     cliEntryPath: string;
     createParentSession?: typeof createOrchestratorParentSession;
   };
   ```

   `executeParentRun` should call:

   ```ts
   const createParentSession = context.createParentSession ?? createOrchestratorParentSession;
   ```

   Production callers do not pass the override.

2. Add a deterministic fake parent session in tests.

   The fake session should:
   - expose `sessionId`;
   - implement `prompt(...)`;
   - inside `prompt`, create real Orchestrator tools from the same context;
   - execute `launch_agent` with:

     ```json
     {
       "runtime": "shell",
       "name": "echo demo",
       "instructions": "printf \"OK\\n\""
     }
     ```

   - execute `read_agent` with `wait: true`;
   - set `getLastAssistantText()` to a final answer containing `OK`;
   - implement `dispose()`.

   The fake should not write events directly. It should make real tool calls so
   the trace conversion path produces the durable events.

3. Add the successful persistence test.

   Preferred test name:

   ```ts
   test("background parent success persists replayable tool and child events", ...)
   ```

   The test should create a parent task record, execute the internal parent run
   path with the fake session factory, then read the parent task events.

   Required assertions:
   - parent task has `agent_event` records with these `data.kind` values in
     order:

     ```text
     run.started
     tool.call
     tool.result
     task.started
     tool.call
     tool.result
     task.finished
     run.final
     ```

   - one `tool.call` is for `launch_agent`;
   - one `tool.call` is for `read_agent`;
   - `task.started.runtime` is `shell`;
   - `task.finished.status` is `succeeded`;
   - `task.finished.output` includes `OK`;
   - `run.final.output` includes `OK`;
   - `events <parent-id> --agent-only --json` returns the same durable events;
   - `watch <parent-id> --agent-only --json` can replay those events.

4. Keep the existing failure-path test.

   The current invalid-agent-dir test still matters because it proves setup
   errors persist as `run.error`.

5. Add an optional live smoke command.

   Do not make this part of normal `pnpm test`.

   ```sh
   pnpm orchestrator run --background --name "parent event smoke" --agent-dir ~/.pi/agent --json --compact \
     'Launch a shell child named "echo demo". Give it this exact task: printf "OK\n". Use read_agent with wait: true. Then tell me the child output.'
   ```

   Then:

   ```sh
   pnpm orchestrator read <parent-id> --wait --json --compact
   pnpm orchestrator events <parent-id> --agent-only --json
   pnpm orchestrator watch <parent-id> --agent-only --json
   ```

## Acceptance

This slice is done when:

- the deterministic test passes without live credentials;
- `pnpm check` passes;
- the successful parent event stream includes run lifecycle, tool calls, child
  task start/finish, and final answer events;
- the job-control backlog marks persisted parent events as done or clearly
  narrowed to optional live smoke only.

## References

- `adr/decisions/0051-persist-parent-events-for-background-runs-20260630-104204.md`
- `adr/specs/persist-parent-events-for-background-runs-20260630-104204.md`
- `adr/specs/job-control-ux-backlog-20260619-203821.md`
- `adr/research/SPIKE-successful-background-parent-events-20260630-135518.md`
- `adr/research/synthesis-successful-background-parent-events-20260630-135518.md`
