# 46. Extract Task Executor Foundation For Protocol Runtimes

Date: 2026-06-24

## Status

Accepted

## Context

Orchestrator currently launches all agent work through the same process path:
build a launch plan, spawn a local process, capture stdout/stderr, parse output,
and mark the task complete when the process exits.

That path is correct for Claude Code, `codex exec`, Pi, shell, and custom
process agents. It is not enough for protocol-backed runtimes such as Codex
app-server, where one task maps to a live protocol session with thread ids, turn
ids, notifications, token updates, API interrupt, and other runtime control.

The protocol-session adapter spec splits the work into stages. The first stage
must create the foundation without changing user-visible behavior.

## Decision

Build Slice 1-3 as the foundation for protocol runtimes:

- introduce a task executor boundary under `launchTask(...)`;
- move the current process execution path into `ProcessTaskExecutor`;
- preserve current process runtime behavior exactly;
- keep `launchTask(...)` responsible for task ids, task records, task files,
  events, output paths, waiting, grouping, and interrupt dispatch;
- let executors own how a task actually runs;
- add provider metadata to task records so future runtimes can store external
  ids such as Codex `threadId` and `turnId`;
- do not add Codex app-server behavior in this slice.

This slice is architecture work, not product UX work. The expected user-facing
result is no behavior change.

## Consequences

All existing runtimes must continue to work:

- `claude-code`
- `codex`
- `pi`
- `shell`
- custom process agents

The first patch must be tested as a behavior-preserving extraction. Existing
launch, read, logs, events, `ps`, wait, timeout, and interrupt behavior should
remain unchanged.

After this slice, Orchestrator has a real internal seam for future runtime
execution models. Slice 4 can add the reusable JSON-RPC stdio client. Slice 5
can add Codex app-server as the first protocol runtime. Slice 6 can harden
protocol interrupt/control behavior. Slice 7 can polish visibility and live
smoke testing.

Provider metadata becomes part of the durable task model, but it should stay
optional and should not clutter human output by default.
