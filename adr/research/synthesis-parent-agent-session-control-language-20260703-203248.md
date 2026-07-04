# Synthesis: Parent-Agent Session Control Language

Date: 2026-07-03

## Summary

Codex app-server gives Orchestrator strong protocol primitives, but those
primitives should not become the mental model for the main Orchestrator agent.
The parent agent should not need to reason about `turn/start` versus
`turn/steer`. It should reason in Orchestrator terms:

- launch an agent;
- keep a session alive when useful;
- send work to that session;
- wait for or read results;
- start a goal when the provider has a native goal mechanism;
- interrupt work that should stop.

Internally, Orchestrator maps that simple vocabulary to the right provider call.

## What The Research Proved

Codex app-server has distinct control mechanisms:

- `turn/start` sends normal work to a thread.
- `turn/steer` adds input to an already-running regular turn.
- `thread/goal/set|get|clear` manages native Codex goal state.
- `thread/settings/update` changes future turn settings without starting work.

The important consequence is that `send` should not mean only "steer an active
turn" once persistent sessions exist. For a persistent session:

- if the session is idle, `send` should start a new turn;
- if a regular turn is running, `send` should steer that turn;
- if the session is running a goal or a non-steerable turn, Orchestrator should
  reject clearly or route through a goal-specific operation.

That keeps the parent agent from choosing provider mechanics directly.

## Parent Agent Mental Model

The parent Orchestrator agent should know this:

- A normal launch creates a managed task that eventually finishes.
- A session launch creates a managed agent that stays running and can receive
  more work.
- `send_agent_message` gives work or a follow-up instruction to a running task
  or session when that runtime supports it.
- `send_agent_message` may start a new operation or add input to the current
  operation. The parent should not care which provider mechanism was used.
- `read_agent` gets the final answer for a finished task, or the latest finished
  operation result for a live session.
- Goal tools are separate because a provider goal is not just another prompt.

## Language To Avoid

Do not teach the parent agent user-facing behavior with provider-specific words:

- Avoid: "turn/start".
- Avoid: "turn/steer".
- Avoid: "mailbox".
- Avoid: "thread" unless showing provider metadata.
- Avoid: "active turn" in normal parent instructions.

Use plain Orchestrator terms:

- "session"
- "operation"
- "send"
- "wait"
- "read"
- "goal"
- "interrupt"

Provider terms can stay in internal docs, debug events, transcript JSON, and ADRs.

## Instruction Set Updates Needed

The parent-agent instructions should evolve from:

```text
send_agent_message sends a follow-up instruction to an active task...
```

to:

```text
send_agent_message sends work or a follow-up instruction to a running task or
session when its runtime supports messages. Use wait: true when you need the
result of that operation. Do not use it for finished tasks.
```

`launch_agent` should learn session launches:

```text
Use session: true when you want a supported runtime to stay alive for multiple
operations.
```

A future `start_agent_goal` tool should be presented as:

```text
start_agent_goal starts a provider-backed goal on a supported running session.
Use it for longer-running objectives that should continue across operations.
```

## Tool Contract Updates Needed

The parent tool set should become:

- `launch_agent`
- `list_agents`
- `read_agent`
- `read_agent_events`
- `read_agent_logs`
- `send_agent_message`
- `start_agent_goal`
- `interrupt_agent`

The parent does not need separate `turn_start` or `steer_agent` tools.

`send_agent_message` should accept:

- `taskId`
- `message`
- `wait?`
- `timeoutMs?`

It should return:

- task summary;
- accepted/running/completed status;
- operation id when one exists;
- provider metadata only as metadata;
- result when `wait: true` completes.

## CLI And Help Updates Needed

CLI help currently says:

```text
Use send only for active tasks whose runtime reports runningMessagesSupported.
```

That should change once idle session sends are implemented:

```text
Use send for running tasks or sessions whose runtime supports messages. For a
persistent session, send starts a new operation when idle or adds input to the
current operation when supported.
```

The compact help contract should make this easy for agents:

- runtime metadata should expose `persistentSessionsSupported`;
- runtime metadata should expose message support;
- task rows should expose `session.state`;
- send output should expose `operation` when applicable.

## Error Language

Errors should be action-oriented:

- "Task already finished. Use resume or launch a new task."
- "Runtime does not support messages."
- "Session is starting. Wait and retry."
- "Session is running a non-steerable operation. Wait for it to finish."
- "Session is running a goal. Use goal tools or wait for the goal operation."

Do not return provider-first errors to the parent unless there is no safe
translation.

## Recommended Implementation Order

1. Update the data model and executor state so persistent sessions track active
   operation and active turn id correctly.
2. Make idle `send` start a new session operation.
3. Keep active regular `send` mapped to Codex `turn/steer`.
4. Add `wait: true` to `send_agent_message` and CLI `send --wait`.
5. Update parent instructions, CLI help, docs, and skill guidance.
6. Add provider-backed goal tools after session operations are solid.

## References

- `adr/research/SPIKE-codex-app-server-control-mechanisms-20260703-112203.md`
- `adr/specs/codex-app-server-persistent-session-operations-20260701-092650.md`
- `adr/specs/codex-app-server-steering-20260630-232736.md`
- `adr/specs/codex-goal-support-20260701-074950.md`
- `packages/agent/src/instructions.ts`
- `packages/agent/src/tools.ts`
- `packages/cli/src/commands/help.ts`
- `doc/codex-app-server.md`
