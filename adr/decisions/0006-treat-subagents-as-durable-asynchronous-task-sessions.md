# 6. Treat subagents as durable asynchronous task sessions

Date: 2026-06-17

## Status

Accepted

## Context

Subagents may run for a while, produce useful intermediate events, fail, need
cancellation, or leave behind logs, transcripts, results, and artifacts. Treating
them as ordinary blocking tool calls would hide the most important behavior from
the user and parent agent.

Claude Code's background-task UX and Codex's explicit control-plane ideas both
point toward durable task/session records.

## Decision

Represent every launched subagent as a durable asynchronous task session.

The core tool surface is:

- `launch_agent`: create a task and return immediately;
- `list_agents`: list visible task records;
- `wait_agent`: wait for activity or completion;
- `send_message`: steer or record a follow-up message when supported;
- `interrupt_agent`: stop a running worker;
- `read_agent_output`: read result-oriented output;
- `read_agent_events`: inspect structured task events.

V1 persistence can be file-backed under `.orchestrator/tasks/<task-id>/`, with
`task.json`, stdout/stderr logs, JSONL events, transcript, result, summary, and
artifacts.

## Consequences

This makes background work observable and controllable. The parent agent can
keep working, inspect only useful results, and avoid loading full worker chatter
into its context.

The runtime must own process supervision, status transitions, capacity limits,
timeouts, output caps, process-group cleanup, and task event writing.

SQLite may replace file-backed storage later if querying, recovery, or
concurrency pressure demands it. That is not required for V1.
