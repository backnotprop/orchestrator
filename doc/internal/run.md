# How the Parent Agent Runs and Waits

Now the parent agent can actually wait for a child result before answering.

Example request:

```sh
orchestrator run 'Launch a Claude Code child to review the API package, launch a Codex child to inspect the task store, wait for both, then summarize what they found.'
```

## What Happens

The parent agent is a Pi session with only Orchestrator tools enabled. The CLI
owns process supervision, task files, logs, events, and final result capture.

See [supervision-model.svg](supervision-model.svg) for the process/task-store
layer diagram.

Foreground `orchestrator run`:

```text
packages/cli/src/cli.ts
  main()
    -> commandRun(parseRunOptions(argv))
      -> executeParentRun(options)
        -> createRunStreamSequencer({ runId })
        -> createOrchestratorParentSession({
             parentRunId,
             parentSessionId: () => parentSessionId,
             backgroundLauncher: launchInBackground,
             trace?
           })
          -> packages/agent/src/session.ts
             createOrchestratorParentSession()
               -> createOrchestratorAgentTools()
               -> createAgentSession({
                    noTools: "builtin",
                    tools: ["launch_agent", "list_agents", ...],
                    customTools: orchestratorTools
                  })
        -> session.prompt(buildOrchestratorParentPrompt(request))
          -> Pi owns the model/tool/model loop
        -> session.getLastAssistantText()
        -> print final answer, JSON, or stream-json events
        -> session.dispose()
```

Background `orchestrator run --background`:

```text
packages/cli/src/cli.ts
  main()
    -> commandRun()
      -> commandRunBackground()
        -> taskId = randomUUID()
        -> writeParentRunRequest()
           ~/.orchestrator/parent-run-requests/<task-id>.json
        -> parentRunLaunchPlan({
             runtime: "orchestrator",
             executable: process.execPath,
             args: ["--experimental-strip-types", cli.ts, "__run-parent-task", requestPath]
           })
        -> launchInBackground(launchInput)
          -> writeRunRequest()
             ~/.orchestrator/run-requests/<task-id>.json
          -> spawn node cli.ts __run-task <run-request>
          -> waitForTaskRecord()
        -> print parent task id

detached supervisor process
  cli.ts __run-task <run-request>
    -> commandRunTask()
      -> launchTask(launchInput)
        -> initializeTaskFiles()
           ~/.orchestrator/tasks/<task-id>/
        -> spawn node cli.ts __run-parent-task <parent-run-request>
        -> capture stdout/stderr/events/result through normal task machinery

parent task process
  cli.ts __run-parent-task <parent-run-request>
    -> commandRunParentTask()
      -> executeParentRun({
           parentRunId: parent task id,
           parentTaskId: parent task id,
           traceTools: "off",
           streamJson: false
         })
      -> write final parent answer to stdout

supervisor close handler
  -> output adapter finalizes
  -> result.md gets final parent answer
  -> task.json gets succeeded/failed/cancelled/timed_out
  -> events.jsonl gets result and terminal event
```

Child launch from the parent:

```text
Pi model chooses tool call
  -> launch_agent(params)
    -> packages/agent/src/tools.ts
       createLaunchAgentTool().execute()
         -> loadConfiguredRuntimeRegistry()
         -> buildAgentLaunchPlan({
              runtime: "codex" | "claude-code" | custom,
              task: params.instructions,
              model: params.model,
              outputMode: params.outputMode
            })
         -> LaunchTaskInput {
              taskId,
              plan,
              name?,
              model?,
              parent: {
                parentRunId,
                parentTaskId?,
                parentSessionId?,
                parentToolCallId
              }
            }
         -> backgroundLauncher(launchInput)
            // CLI parent runs pass launchInBackground here.
         -> returns task summary to the model

detached child supervisor
  cli.ts __run-task <run-request>
    -> commandRunTask()
      -> launchTask()
        -> task.json, stdout.log, stderr.log, events.jsonl,
           transcript.jsonl, result.md, artifacts/
        -> append queued/starting/running events
        -> spawn provider CLI
        -> output adapter normalizes provider stdout/stderr
        -> on close, write result.md and terminal status
```

Waiting for a child:

```text
Pi model chooses tool call
  -> read_agent({ taskId, wait: true, timeoutMs?, maxBytes? })
    -> packages/agent/src/tools.ts
       createReadAgentTool().execute()
         -> waitForTask({
              workspaceRoot,
              orchestratorDir,
              taskId,
              timeoutMs,
              onProgress?
            })
           -> packages/core/src/tasks/wait.ts
              loop:
                readTaskRecord(task.json)
                if status is terminal, return completed
                if timeout elapsed, return timeout
                optionally emit progress trace
                sleep interval
         -> readTaskOutput(result.md, maxBytes)
         -> read latest token usage from task events when present
         -> return retrievalStatus, task summary, output, usage?
```

If the child does not finish before `timeoutMs`, the parent gets:

```json
{
  "retrievalStatus": "timeout",
  "task": {
    "status": "running"
  },
  "output": "whatever is currently available"
}
```

So the parent can say "it’s still running," inspect logs/events, wait again, or stop it.

## Background Parent Runs

`orchestrator run` stays foreground by default:

```sh
orchestrator run "Launch a Claude Code child to review the API package, launch a Codex child to inspect the task store, wait for both, then summarize what they found."
```

Use `--background` when the parent agent itself should be a managed task:

```sh
orchestrator run --background --name "api and store review" "Launch a Claude Code child to review the API package, launch a Codex child to inspect the task store, wait for both, then summarize what they found."
```

That returns a task id immediately. The parent task uses runtime id `orchestrator`
and can be inspected the same way as child tasks:

```sh
orchestrator ps
orchestrator watch <parent-task-id>
orchestrator read <parent-task-id>
orchestrator logs <parent-task-id> --follow
orchestrator events <parent-task-id>
orchestrator interrupt <parent-task-id>
```

When a background parent launches children, those children keep a link to the
parent task id. `ps` uses that link to group the parent and its children
together.
