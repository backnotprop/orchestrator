# How the Parent Agent Runs and Waits

Now the parent agent can actually wait for a child result before answering.

Example request:

```sh
orchestrator run 'Launch a Codex child using model gpt-5.4-mini. Ask it to say hello, wait for it, then tell me what it said.'
```

What happens:

```text
1. CLI starts the parent Orchestrator agent.
2. Parent model decides to call launch_agent.
3. launch_agent starts Codex/Claude/custom as a background task.
4. Orchestrator writes that child task to .orchestrator/tasks/<task-id>/.
5. Parent receives the child task id.
6. Parent calls read_agent({ taskId, wait: true }).
7. Core waitForTask reads task.json until the child reaches:
   succeeded, failed, cancelled, or timed_out.
8. read_agent reads result.md with byte limits.
9. Parent receives:
   retrievalStatus: "completed"
   task: { status, runtime, name, taskDir, ... }
   output: "child result..."
10. Parent answers the user using the child result.
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
orchestrator run "Figure out what needs to change in this repo."
```

Use `--background` when the parent agent itself should be a managed task:

```sh
orchestrator run --background --name "repo plan" "Figure out what needs to change in this repo."
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
