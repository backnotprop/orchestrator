# 24. Run Parent Agent As Managed Background Task

Date: 2026-06-18

## Status

Accepted

## Context

Orchestrator can now manage child agents as durable jobs. A child agent gets a
task id, task files, logs, events, a final result, and can be watched, read, or
interrupted later.

`orchestrator run` is different today. It starts the parent Orchestrator agent
in the foreground, lets that parent launch or wait on child agents, prints the
parent's final answer, and exits. That works for short interactive runs, but it
does not let the user leave a parent running, close the terminal, reattach
later, or stop the parent as a job.

This creates an uneven model: child agents are manageable jobs, but parent
agents are not. If the product is about managing many agents, parent agents
should be manageable too.

## Decision

Add a background mode for parent runs:

```sh
orchestrator run --background --name "repo plan" "<request>"
```

This command will start the parent Orchestrator agent as a managed task and
return immediately:

```text
taskId: <id>
name: repo plan
status: starting
runtime: orchestrator
```

The parent task will use the same task store and task commands as child agents:

```sh
orchestrator ps
orchestrator watch <parent-task-id>
orchestrator read <parent-task-id>
orchestrator logs <parent-task-id> --follow
orchestrator events <parent-task-id>
orchestrator interrupt <parent-task-id>
```

Use `orchestrator` as the parent runtime id. Keep normal `orchestrator run`
foreground-only for now. Only `orchestrator run --background` creates a parent
task in this slice.

The implementation should reuse the existing task supervisor instead of adding a
new job engine. The CLI can launch an internal parent-task entrypoint, such as
`__run-parent-task`, which runs the same parent-agent code path, writes the
final answer to `result.md`, and lets stdout, stderr, task events, and errors be
captured normally.

When a background parent launches child agents, those child tasks should remain
normal agent tasks. They should keep the existing parent run metadata and, when
available, also link to the parent task id so `ps` and the future TUI can show
parent and children together.

Do not add a full TUI, automatic parent continuation, Monitor-style event
streaming, hidden worker recipes, or a new plugin system as part of this
decision.

## Implementation Notes

`orchestrator run --background` preallocates a task id, writes a parent-run
request file, and starts the normal detached task supervisor. The supervised
process runs the internal `__run-parent-task` command, which executes the same
Pi-backed parent-agent path used by foreground `orchestrator run`.

The parent task uses runtime id `orchestrator`, but `orchestrator` is not added
to the public launchable runtime registry. Users start parent tasks through
`orchestrator run --background`, not `orchestrator launch orchestrator`.

Child tasks launched by a managed parent include `parentTaskId` in addition to
the existing parent run/session/tool-call metadata. The operations view groups
the parent task and those children together under the parent task id.

## Consequences

Parent agents and child agents will share one job model. Users can start
multiple parent agents, leave them running, inspect them later, and interrupt
work that no longer matters.

`ps --watch` becomes more useful because it can show parent jobs and child jobs
from the same task state instead of treating foreground parent runs as temporary
terminal sessions.

The implementation stays small because it reuses the existing task store,
supervisor, logs, events, results, and interrupt behavior.

Foreground `orchestrator run` stays simple. Users who want an immediate answer
can keep using it. Users who want durable work use `--background`.

The main follow-up is parent-child display polish. Once parent tasks exist, the
operations view should make it easy to see which children belong to which parent
and to inspect a whole parent run without hunting for task ids.
