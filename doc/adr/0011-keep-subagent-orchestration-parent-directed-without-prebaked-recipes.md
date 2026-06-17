# 11. Keep subagent orchestration parent directed without prebaked recipes

Date: 2026-06-17

## Status

Accepted

## Context

The product is an orchestrator agent that can launch other headless agents.
Earlier planning language around role recipes and agent definitions risked
implying a second orchestration layer with pre-baked worker templates.

That is not the intended product shape. The only required orchestration move is
the parent agent launching a supported subagent runtime with custom
instructions for that specific task.

## Decision

Keep subagent orchestration parent-directed.

The core launch primitive is:

```text
parent agent chooses runtime
parent agent writes full task/custom instructions
parent agent optionally sets cwd, model hint, write permission, isolation,
timeout, output cap, metadata, and display name
parent agent receives a task id and can list/read/interrupt the worker
```

Do not ship pre-baked agent recipes, built-in role templates, fixed multi-step
workflows, or hidden prompts in V1.

The optional `name` field is display metadata only. It must not select hidden
behavior.

## Consequences

This keeps the core small and honest. The orchestrator's job is to manage
background agent sessions, not maintain a taxonomy of worker personas.

If the parent wants a worker to review, implement, research, compare, or
summarize, the parent says that directly in the task instructions for that
launch.

Future convenience shortcuts are allowed only if they visibly expand to normal
`launch_agent` calls. They must not become hidden templates or a separate
workflow system.
