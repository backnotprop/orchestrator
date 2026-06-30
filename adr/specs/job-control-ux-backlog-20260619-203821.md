# Job-Control UX Backlog

Date: 2026-06-19

## Status

Backlog.

## Context

A live `ps --watch` test exposed a gap between visibility and control.
Orchestrator can show grouped parent/child agents, status, last activity, and
token usage when a runtime reports it. But stopping work was clumsy and too easy
to get wrong.

This matters for humans and agents. A human watching a rollout needs a fast way
to stop the whole group. An agent using Orchestrator as a tool needs commands
that avoid scraping large JSON payloads or resolving full task ids manually.

## Problems Found

- Short ids shown in `ps` cannot be used with `interrupt`.
  - The UI prints short ids like `0ea6bbc9`.
  - `orchestrator interrupt 0ea6bbc9` fails because the command requires the
    full task id.
  - This makes the visible id less useful than it looks.
- There is no group kill command.
  - Stopping a parent run did not stop its child agents.
  - The operator had to list the group, copy full child ids, then interrupt each
    child one by one.
- `interrupt <parent>` does not stop child agents.
  - This is dangerous for budget.
  - A cancelled parent can leave expensive children running.
- `ps --json` is too noisy for quick control tasks.
  - It contains the data, but the common workflow of "find running children and
    stop them" requires parsing a large object.
  - Agents need a smaller control-friendly surface.
- Codex token behavior was not clearly represented before live testing.
  - Claude Code emitted useful live token updates during the run.
  - Codex emitted activity while running, but this adapter path did not show
    live token usage before completion.
  - The product should distinguish "not supported by this adapter path yet" from
    "impossible."
- Operator behavior matters too.
  - When asked to launch agents, the tool operator should launch agents.
  - Exploration and explanation should not block the direct requested action.

## Backlog Items

1. Support short ids anywhere a task id is accepted.
   - `orchestrator interrupt 0ea6bbc9`
   - `orchestrator read 0ea6bbc9`
   - `orchestrator logs 0ea6bbc9`
   - If a short id is ambiguous, fail with the matching full ids.

2. Add group interruption.
   - Preferred shape:

     ```sh
     orchestrator interrupt --parent <parent-id> --children
     ```

   - Also consider:

     ```sh
     orchestrator interrupt --group <group-id>
     ```

   - The command should show what it stopped.

3. Make parent interruption safer.
   - Decide whether `interrupt <parent-task-id>` should prompt or require a flag
     to stop children.
   - Non-interactive agent use needs an explicit flag, not a prompt.
   - Budget safety argues for a convenient "parent plus children" path.

4. Add a compact machine-control view.
   - Avoid forcing agents to scrape full `ps --json`.
   - Possible command:

     ```sh
     orchestrator ps --json --running --parent <id>
     ```

   - Or add a dedicated command:

     ```sh
     orchestrator tasks --running --parent <id> --json
     ```

5. Document Codex live-token limits clearly.
   - Current adapter path: `codex exec --json`.
   - Observed behavior: live activity events while running; token usage not
     observed until a completion/turn boundary.
   - Follow-up research should verify whether another Codex surface can expose
     token usage earlier.

## Current Status

The original control-path items are largely implemented now: short ids work in
task commands, parent/group interruption exists, compact JSON exposes follow-up
args, and token usage is shown when runtimes emit it. Keep the historical list
above for context, but treat the manual smoke checklist below as the next
unresolved UX backlog.

## Manual Smoke Refinement Checklist

A June 2026 manual smoke pass showed that the core CLI is usable: compact JSON
returns follow-up args, short ids work, token usage appears when runtimes emit
it, resume works for supported runtimes, and grouped `ps --all` is readable.
The next refinements are smaller product fixes around observability and
agent-facing behavior:

- [x] Persist parent run and tool events for background runs.
  - Background `orchestrator run --background` should preserve `run.started`,
    `tool.call`, `tool.result`, `task.started`, `task.finished`, and
    `run.final` events.
  - `events <parent-id> --agent-only`, `watch <parent-id>`, `ps`, and the
    future TUI should be able to replay what the parent did.
  - Covered by a deterministic successful parent-task integration test that uses
    the real task store, real parent tools, a real child task, and `events` /
    `watch` replay.

- [x] Tighten parent `launch_agent` runtime guidance.
  - If the user asks for a shell/local-command child, the parent should launch
    `runtime: "shell"` directly instead of trying Codex first.
  - Tool instructions should clearly separate shell/local commands from
    Codex/Claude model work.
  - Prefer sharper schema/instructions before adding heavy product logic.

- [x] Keep structured output as the normal provider path.
  - Default structured modes should remain the recommended path for reliable
    output, provider metadata, token usage, and resume.
  - Provider text modes should be documented as diagnostic or provider-specific.
  - Resume docs should continue to say that resumable tasks need stored provider
    metadata.
  - Covered in README command docs, CLI help text/JSON help, compact help, and
    the packaged Orchestrator skill.

- [x] Clarify or improve `logs --stream all`.
  - `logs --follow --stream all` preserves combined stdout/stderr order for live
    raw output.
  - JSON logs remain a snapshot with separate `stdout` and `stderr` fields by
    design.
  - Covered in CLI help, README command docs, the packaged Orchestrator skill,
    and the combined-output test.

- [x] Add an optional broader parent-run smoke test.
  - Start a live parent run, have it launch a child, wait for the child, and
    finish.
  - Covered by `test/parent-run-smoke.test.ts`.
  - The test is skipped by default. Run it with `RUN_PARENT_RUN_SMOKE=1`.
  - It verifies parent/child grouping, child task result, replayable parent
    agent events, watch replay, and readable compact follow-up commands through
    the full CLI process path.

## Priority

The manual-smoke backlog items above are now covered. Treat future work here as
new TUI or operator polish, not as unfinished cleanup from this smoke pass.

These are product-quality fixes. They make Orchestrator easier to debug and
safer for agents to use without changing the core task model.
