# 17. Build parent AI agent as Pi-backed package over Orchestrator core

Date: 2026-06-18

## Status

Accepted

## Context

Orchestrator already has a core runtime layer and CLI for launching, listing,
reading, watching, logging, and interrupting background agent tasks.

The next product layer is the parent AI agent: the agent that receives a user
request, decides which child agents to launch, reads their task state/results,
and responds to the user.

We have decided not to fork Pi. Pi already exposes package surfaces for model
calls, provider/model/auth handling, streaming, tool execution, sessions, and
compaction. Orchestrator should reuse those pieces as dependencies while keeping
its own task/runtime core.

We also need to avoid implying that the parent agent follows a fixed call stack
or recipe. It receives a user request and has a small menu of tools available.
It decides which tools to call for that request.

## Decision

Build the parent AI agent as a separate package over Orchestrator core:

```text
packages/agent
  Pi-powered parent AI session
  Orchestrator tool definitions
  parent session storage
```

The package should depend on:

- `@backnotprop/orchestrator-core` for runtime registry, launch plans, task
  store, supervisor, logs, events, results, and interrupt behavior;
- Pi packages for the parent model/session/tool loop.

Start with the `@earendil-works/pi-coding-agent` SDK because it already exposes
auth storage, model registry, session manager, tool definition helpers, event
streaming, and compaction policy. If that SDK is too coupled to Pi's product
shell, drop down to `@earendil-works/pi-agent-core` plus
`@earendil-works/pi-ai` and own more glue locally.

The parent agent should be available through a CLI command:

```sh
orchestrator run "<request>"
```

The parent receives a user request, starts or resumes a parent session, and can
choose from these Orchestrator tools:

```text
launch_agent
list_agents
read_agent
read_agent_events
read_agent_logs
interrupt_agent
```

This list is a tool menu, not an execution sequence. For one request the parent
might only call `launch_agent`. For another it might launch multiple child
agents, inspect events, read final results, and then answer.

The parent agent must call Orchestrator core APIs directly. It must not scrape
human CLI output and must not spawn child-agent subprocesses itself.

Parent sessions are separate from child task records:

```text
~/.orchestrator/auth.json
~/.orchestrator/models.json
~/.orchestrator/sessions/

<workspace>/.orchestrator/tasks/<task-id>/
  task.json
  stdout.log
  stderr.log
  events.jsonl
  transcript.jsonl
  result.md
```

Use Orchestrator-owned paths for auth, model config, and sessions even when the
underlying file formats/classes come from Pi. Do not silently depend on
`~/.pi`.

Tool results should be bounded and model-readable. A launch result should return
task ID, task name, runtime, status, model hint, and paths. Logs and events
should return short snippets by default, with explicit limits.

Do not include these in the first parent-agent slice:

- TUI;
- worker recipes;
- hidden role templates;
- plugin or extension system;
- unbounded log streaming into the parent model;
- token-count dashboard work.

## Consequences

This keeps the architecture clear:

- Pi runs the parent AI session.
- Orchestrator runs and supervises child agents.
- The CLI, parent agent, and future TUI all use the same task/runtime data.

This should let us build the parent agent quickly without rebuilding provider
auth, model selection, streaming, session history, tool execution, and
compaction from scratch.

The main risk is Pi package coupling. The first implementation should prove that
we can create a minimal parent session with only Orchestrator tools exposed. If
the coding-agent SDK drags in too much app behavior, use the lower-level Pi
packages and implement the missing glue in `packages/agent`.

The parent agent will need tests around:

- creating a minimal session;
- exposing only the intended tools;
- launching a child task through core APIs;
- reading bounded task output;
- handling missing/disabled runtimes;
- interrupting a running child task;
- keeping parent session state separate from child task state.
