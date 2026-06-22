# SPIKE: Claude Code Monitor and Background Task Capabilities

Date: 2026-06-18

## Question

How does Claude Code keep work moving after it launches long-running commands or
subagents, and what should Orchestrator copy for parent-agent runs?

## Short Answer

Claude Code-inspired UX does not rely on the model sleeping and polling. It
pushes waiting into the host runtime.

The pattern is:

1. Launch work as a task.
2. Give the task an id and output stream.
3. Keep writing logs/transcript/progress to task state.
4. Notify the parent when the task changes or finishes.
5. Let the parent continue from a task event instead of a manual polling loop.

`Monitor` is related, but it is not the whole system. Monitor-style behavior is
best for streaming observations such as logs or external status checks. For
"wait until this child agent is done", Orchestrator should use managed tasks and
host-side waiting.

## Evidence From Product Behavior

### Sleeping And Polling Are The Wrong Model

The important behavior to copy is that long-running work should not be driven by
model-authored `sleep` loops. The host should own the wait and should wake the
parent with task status when progress or completion is available.

### Background Tasks Own Process State

Background tasks should own:

- task id;
- process status;
- raw stdout/stderr;
- normalized events;
- final output;
- cancellation state;
- usage when available.

Monitor-like tasks can be represented as a display/notification variant, but
they should not replace the core task store.

### Notifications Re-Enter The Parent Loop

The key design point is not the specific tool name. The key design point is that
task notifications re-enter the parent agent loop through the host runtime. The
parent should not need to repeatedly ask "are you done yet?"

Notifications should also be scoped. A parent run should see its own child task
events. Unrelated parents or child agents should not receive those events.

### Background Agents Use The Same Shape

Background subagents should behave like any other managed task:

- launch quickly;
- stream progress when available;
- expose bounded reads;
- preserve raw logs;
- carry token usage when available;
- support interruption;
- finish with a durable result.

## Current Orchestrator Gap At The Time Of The Spike

At the time this was written, the parent agent could launch a child and return
immediately, but it needed a cleaner host-side wait path. The desired behavior
was:

- parent calls `launch_agent`;
- parent receives a task id;
- parent calls `read_agent` with `wait: true`;
- host blocks inside the tool call until the child finishes or times out;
- parent receives the final child result and answers the user.

That avoids shell sleep, polling loops, and brittle prompt conventions.

## Recommendation

Do not build a general Monitor clone first.

Build the smaller thing Orchestrator needs:

1. Keep `launch_agent` background-first.
2. Let `read_agent({ wait: true })` block in host code.
3. Return bounded output and terminal status.
4. Return timeout status without pretending the task is done.
5. Preserve raw logs/events for debugging.
6. Keep parent runs eligible to become managed tasks themselves.

This gives the parent the missing ability to launch a Codex or Claude child,
wait for the result, and answer the user in the same run.
